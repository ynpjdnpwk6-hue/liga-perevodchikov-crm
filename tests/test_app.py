import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest

from app import CRMServer, connect, set_admin


class CRMTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.database = Path(self.temp.name) / 'crm.sqlite3'
        set_admin(self.database, 'admin', 'test-password-12345')
        self.server = CRMServer(('127.0.0.1', 0), self.database)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.cookie = ''
        self.csrf = ''

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, path, method='GET', data=None, use_csrf=True, headers=None):
        client = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        request_headers = {'Content-Type': 'application/json', 'Cookie': self.cookie}
        if use_csrf:
            request_headers['X-CSRF-Token'] = self.csrf
        request_headers.update(headers or {})
        client.request(method, path, json.dumps(data).encode() if data is not None else None, request_headers)
        response = client.getresponse()
        status, response_headers = response.status, dict(response.getheaders())
        raw = response.read()
        result = json.loads(raw) if response_headers.get('Content-Type', '').startswith('application/json') else raw.decode('utf-8-sig')
        client.close()
        return status, result, response_headers

    def login(self):
        status, result, headers = self.request('/api/login', 'POST', {'username': 'admin', 'password': 'test-password-12345'})
        self.assertEqual(status, 200)
        self.cookie = headers['Set-Cookie'].split(';')[0]
        self.csrf = result['csrf']
        return headers

    def records(self):
        self.login()
        status, customer, _ = self.request('/api/customers', 'POST', {'name': 'Тестовый заказчик', 'organization': 'Учебная организация'})
        self.assertEqual(status, 201)
        status, translator, _ = self.request('/api/translators', 'POST', {'name': 'Тестовый переводчик', 'languages': ['Арабский', 'Английский'], 'active': True})
        self.assertEqual(status, 201)
        return customer['id'], translator['id']

    def test_session_csrf_and_logout(self):
        self.assertEqual(self.request('/api/data')[0], 401)
        headers = self.login()
        self.assertIn('HttpOnly', headers['Set-Cookie'])
        self.assertIn('SameSite=Strict', headers['Set-Cookie'])
        self.assertEqual(self.request('/api/customers', 'POST', {'name': 'Заказчик'}, use_csrf=False)[0], 403)
        self.assertEqual(self.request('/api/customers', 'POST', {'name': 'Заказчик'}, headers={'Origin': 'https://evil.example'})[0], 403)
        self.assertEqual(self.request('/api/data')[0], 200)
        self.assertEqual(self.request('/api/logout', 'POST', {})[0], 200)
        self.assertEqual(self.request('/api/data')[0], 401)
        self.assertEqual(self.request('/api/export')[0], 401)

    def test_full_order_lifecycle_and_financial_totals(self):
        customer, translator = self.records()
        status, created, _ = self.request('/api/orders', 'POST', {'customer_id': customer, 'language': 'Арабский', 'amount': '1000.05'})
        self.assertEqual(status, 201)
        order_id = created['id']
        status, _, _ = self.request(f'/api/orders/{order_id}', 'PATCH', {'translator_id': translator, 'status': 'assigned'})
        self.assertEqual(status, 200)
        self.assertEqual(self.request('/api/data')[1]['summary']['commission'], 0)
        self.assertEqual(self.request(f'/api/orders/{order_id}', 'PATCH', {'status': 'completed', 'commission_paid': '100'})[0], 200)
        data = self.request('/api/data')[1]
        self.assertEqual(data['summary'], {'active': 0, 'revenue': 100005, 'commission': 30002, 'commission_due': 20002})
        self.assertEqual(data['orders'][0]['translator_share'], 70003)
        self.assertEqual(self.request(f'/api/orders/{order_id}', 'PATCH', {'commission_paid': '300.02'})[0], 200)
        self.assertEqual(self.request('/api/data')[1]['summary']['commission_due'], 0)
        self.assertEqual(self.request(f'/api/orders/{order_id}', 'PATCH', {'status': 'cancelled'})[0], 400)
        # A new HTTP server reads the persisted order and session from the same database.
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.server = CRMServer(('127.0.0.1', 0), self.database)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.assertEqual(self.request('/api/data')[1]['orders'][0]['amount'], 100005)
        with connect(self.database) as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM audit').fetchone()[0], 6)

    def test_assignment_and_input_validation(self):
        customer, translator = self.records()
        valid = {'customer_id': customer, 'language': 'Арабский', 'amount': '8000'}
        for changes in [{'amount': '-1'}, {'amount': 'NaN'}, {'amount': '0.001'}, {'amount': True}, {'customer_id': True}, {'translator_id': False}, {'status': 'completed'}, {'translator_id': translator, 'language': 'Китайский', 'status': 'assigned'}, {'scheduled_at': '2026-02-30T12:00'}, {'commission_paid': '1'}]:
            with self.subTest(changes=changes):
                self.assertEqual(self.request('/api/orders', 'POST', valid | changes)[0], 400)
        status, created, _ = self.request('/api/orders', 'POST', valid | {'translator_id': translator, 'status': 'assigned'})
        self.assertEqual(status, 201)
        self.assertEqual(self.request(f'/api/translators/{translator}', 'PATCH', {'name': 'Тестовый переводчик', 'languages': ['Арабский'], 'active': False})[0], 400)
        self.assertEqual(self.request(f'/api/translators/{translator}', 'PATCH', {'name': 'Тестовый переводчик', 'languages': ['Английский'], 'active': True})[0], 400)
        self.assertEqual(self.request(f"/api/orders/{created['id']}", 'PATCH', {'status': 'completed'})[0], 200)
        self.assertEqual(self.request(f'/api/translators/{translator}', 'PATCH', {'name': 'Тестовый переводчик', 'languages': ['Английский'], 'active': False})[0], 200)
        self.assertEqual(self.request(f"/api/orders/{created['id']}", 'PATCH', {'commission_paid': '2400'})[0], 200)
        self.assertEqual(self.request('/api/orders', 'POST', valid | {'translator_id': translator, 'status': 'assigned'})[0], 400)

    def test_export_handles_formula_and_csv_fields(self):
        customer, translator = self.records()
        self.request(f'/api/customers/{customer}', 'PATCH', {'name': '=HYPERLINK("x")', 'organization': 'Строка; с разделителем'})
        self.request('/api/orders', 'POST', {'customer_id': customer, 'translator_id': translator, 'status': 'completed', 'language': 'Арабский', 'amount': '100'})
        status, output, headers = self.request('/api/export')
        self.assertEqual(status, 200)
        self.assertIn("'=HYPERLINK", output)
        self.assertIn('"Строка; с разделителем"', output)
        self.assertIn('attachment', headers['Content-Disposition'])
        self.assertIn('100.00;30.00;0.00;30.00', output)

    def test_login_throttling_and_password_reset(self):
        for _ in range(10):
            self.assertEqual(self.request('/api/login', 'POST', {'username': 'admin', 'password': 'wrong'})[0], 401)
        self.assertEqual(self.request('/api/login', 'POST', {'username': 'admin', 'password': 'test-password-12345'})[0], 429)
        self.server.login_attempts.clear()
        self.login()
        set_admin(self.database, 'admin', 'changed-password-12345')
        self.assertEqual(self.request('/api/data')[0], 401)


if __name__ == '__main__':
    unittest.main()
