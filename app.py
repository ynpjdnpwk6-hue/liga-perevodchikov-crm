"""Single-admin CRM. Python 3.12+, SQLite, no third-party dependencies."""
import argparse
import csv
import getpass
import hashlib
import hmac
import io
import json
import logging
import os
from pathlib import Path
import secrets
import sqlite3
import time
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

ROOT = Path(__file__).resolve().parent
STATUSES = ('new', 'assigned', 'in_progress', 'completed', 'cancelled')
SCHEMA = '''
CREATE TABLE IF NOT EXISTS admins (
 username TEXT PRIMARY KEY, salt TEXT NOT NULL, password_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, username TEXT NOT NULL REFERENCES admins(username),
 csrf TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS translators (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '',
 languages TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)));
CREATE TABLE IF NOT EXISTS customers (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, organization TEXT NOT NULL DEFAULT '',
 phone TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS orders (
 id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id),
 translator_id INTEGER REFERENCES translators(id), language TEXT NOT NULL,
 scheduled_at TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
 notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'new',
 amount INTEGER NOT NULL DEFAULT 0 CHECK(amount >= 0),
 commission_percent INTEGER NOT NULL DEFAULT 30 CHECK(commission_percent = 30),
 commission_paid INTEGER NOT NULL DEFAULT 0 CHECK(commission_paid >= 0),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit (
 id INTEGER PRIMARY KEY, username TEXT NOT NULL, action TEXT NOT NULL,
 entity TEXT NOT NULL, entity_id INTEGER NOT NULL, created_at TEXT NOT NULL);
'''


def connect(path):
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    return conn


def initialize(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with connect(path) as conn:
        conn.executescript(SCHEMA)
        conn.execute('PRAGMA journal_mode = WAL')
    os.chmod(path, 0o600)


def password_hash(password, salt):
    return hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()


def set_admin(path, username, password):
    username = username.strip()
    if not username or len(username) > 80 or not 12 <= len(password) <= 1024:
        raise ValueError('Логин обязателен; пароль должен содержать минимум 12 символов.')
    initialize(path)
    salt = secrets.token_hex(16)
    digest = password_hash(password, salt)
    with connect(path) as conn:
        conn.execute('INSERT INTO admins VALUES (?,?,?) ON CONFLICT(username) DO UPDATE SET salt=excluded.salt,password_hash=excluded.password_hash', (username, salt, digest))
        conn.execute('DELETE FROM sessions WHERE username=?', (username,))


def money(value):
    if isinstance(value, bool):
        raise ValueError('Некорректная сумма.')
    try:
        result = Decimal(str(value))
        if not result.is_finite() or result < 0 or result > 100000000:
            raise ValueError('Сумма должна быть от 0 до 100 000 000 ₽.')
        if result.as_tuple().exponent < -2:
            raise ValueError('Укажите сумму с точностью до копейки.')
        return int(result * 100)
    except (InvalidOperation, TypeError):
        raise ValueError('Некорректная сумма.') from None


def commission(amount):
    return int((Decimal(amount) * Decimal('0.30')).quantize(Decimal('1'), rounding=ROUND_HALF_UP))


def string(data, field, required=False, limit=500):
    value = data.get(field, '')
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError(f'Некорректное поле: {field}.')
    value = value.strip()
    if required and not value:
        raise ValueError(f'Заполните поле: {field}.')
    return value


def record_id(value):
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError('Некорректный идентификатор записи.')
    return value


def now():
    return datetime.now().astimezone().isoformat(timespec='seconds')


def enriched(row):
    item = dict(row)
    item['commission'] = commission(item['amount'])
    item['translator_share'] = item['amount'] - item['commission']
    item['commission_due'] = item['commission'] - item['commission_paid'] if item['status'] == 'completed' else 0
    return item


class CRMServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, database, secure_cookie=False):
        self.database = str(database)
        self.secure_cookie = secure_cookie
        self.login_attempts = {}
        self.login_lock = Lock()
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Do not log query strings, submitted bodies, or personal data.
        logging.info('%s %s %s', self.client_address[0], self.command, self.path.split('?')[0])

    def send(self, status, payload, content_type='application/json; charset=utf-8', headers=None):
        body = json.dumps(payload, ensure_ascii=False).encode() if content_type.startswith('application/json') else payload
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'same-origin')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        length = int(self.headers.get('Content-Length', '0'))
        if length < 1 or length > 65536:
            raise ValueError('Некорректный размер запроса.')
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            raise ValueError('Ожидается JSON.')
        data = json.loads(self.rfile.read(length))
        if not isinstance(data, dict):
            raise ValueError('Ожидается объект JSON.')
        return data

    def session(self, conn):
        cookies = SimpleCookie()
        try:
            cookies.load(self.headers.get('Cookie', ''))
            token = cookies['liga_session'].value if 'liga_session' in cookies else ''
        except Exception:
            token = ''
        return conn.execute('SELECT * FROM sessions WHERE token_hash=? AND expires>?', (hashlib.sha256(token.encode()).hexdigest(), int(time.time()))).fetchone()

    def cookie(self, token, age=43200):
        return f'liga_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={age}' + ('; Secure' if self.server.secure_cookie else '')

    def origin_ok(self):
        origin = self.headers.get('Origin')
        host = self.headers.get('Host', '')
        scheme = 'https' if self.server.secure_cookie else 'http'
        return not origin or origin == f'{scheme}://{host}'

    def do_GET(self):
        self.dispatch('GET')

    def do_POST(self):
        self.dispatch('POST')

    def do_PATCH(self):
        self.dispatch('PATCH')

    def dispatch(self, method):
        path = self.path.split('?')[0]
        try:
            if method == 'GET' and path in ('/', '/app.js', '/style.css', '/favicon.svg'):
                files = {'/': ('index.html', 'text/html'), '/app.js': ('app.js', 'text/javascript'), '/style.css': ('style.css', 'text/css'), '/favicon.svg': ('favicon.svg', 'image/svg+xml')}
                name, kind = files[path]
                return self.send(200, (ROOT / 'static' / name).read_bytes(), kind + '; charset=utf-8')
            if method != 'GET' and not self.origin_ok():
                return self.send(403, {'error': 'Недопустимый источник запроса.'})
            with connect(self.server.database) as conn:
                if method == 'POST' and path == '/api/login':
                    return self.login(conn, self.body())
                session = self.session(conn)
                if not session:
                    return self.send(401, {'error': 'Войдите в систему.'})
                if method != 'GET' and not hmac.compare_digest(self.headers.get('X-CSRF-Token', ''), session['csrf']):
                    return self.send(403, {'error': 'Обновите страницу и повторите действие.'})
                if method == 'GET' and path == '/api/session':
                    return self.send(200, {'username': session['username'], 'csrf': session['csrf']})
                if method == 'POST' and path == '/api/logout':
                    conn.execute('DELETE FROM sessions WHERE token_hash=?', (session['token_hash'],))
                    conn.commit()
                    return self.send(200, {'ok': True}, headers={'Set-Cookie': self.cookie('', 0)})
                if method == 'GET' and path == '/api/data':
                    return self.send(200, self.snapshot(conn))
                if method == 'GET' and path == '/api/export':
                    return self.export(conn)
                if method in ('POST', 'PATCH') and path.startswith('/api/'):
                    # Serialize validation + write to avoid assigning a translator while deactivating it.
                    conn.execute('BEGIN IMMEDIATE')
                    return self.mutate(conn, session['username'], method, path, self.body())
                self.send(404, {'error': 'Страница не найдена.'})
        except (ValueError, json.JSONDecodeError, UnicodeError) as error:
            self.send(400, {'error': str(error) or 'Некорректный запрос.'})
        except sqlite3.IntegrityError:
            self.send(400, {'error': 'Проверьте связанные записи и заполненные поля.'})
        except Exception:
            logging.exception('Request failed')
            self.send(500, {'error': 'Не удалось выполнить действие. Попробуйте ещё раз.'})

    def login(self, conn, data):
        username = string(data, 'username', True, 80)
        password = data.get('password', '')
        if not isinstance(password, str) or len(password) > 1024:
            raise ValueError('Некорректный пароль.')
        ip = self.client_address[0]
        stamp = time.time()
        with self.server.login_lock:
            attempts = self.server.login_attempts
            for key in list(attempts):
                attempts[key] = [t for t in attempts[key] if stamp - t < 900]
                if not attempts[key]:
                    del attempts[key]
            if len(attempts.get(ip, [])) >= 10:
                return self.send(429, {'error': 'Слишком много попыток. Повторите через 15 минут.'})
            attempts.setdefault(ip, []).append(stamp)
        admin = conn.execute('SELECT * FROM admins WHERE username=?', (username,)).fetchone()
        salt = admin['salt'] if admin else '00' * 16
        digest = password_hash(password, salt)
        if not admin or not hmac.compare_digest(digest, admin['password_hash']):
            return self.send(401, {'error': 'Неверный логин или пароль.'})
        token = secrets.token_urlsafe(32)
        csrf = secrets.token_urlsafe(32)
        conn.execute('DELETE FROM sessions WHERE expires<=?', (int(stamp),))
        conn.execute('INSERT INTO sessions VALUES (?,?,?,?)', (hashlib.sha256(token.encode()).hexdigest(), username, csrf, int(stamp) + 43200))
        conn.commit()
        return self.send(200, {'username': username, 'csrf': csrf}, headers={'Set-Cookie': self.cookie(token)})

    def snapshot(self, conn):
        translators = [dict(r) for r in conn.execute('SELECT * FROM translators ORDER BY name')]
        for row in translators:
            row['languages'] = json.loads(row['languages'])
            row['active'] = bool(row['active'])
        orders = [enriched(r) for r in conn.execute('SELECT o.*, c.name AS customer_name,c.organization,t.name AS translator_name FROM orders o JOIN customers c ON c.id=o.customer_id LEFT JOIN translators t ON t.id=o.translator_id ORDER BY o.id DESC')]
        completed = [o for o in orders if o['status'] == 'completed']
        return {'translators': translators, 'customers': [dict(r) for r in conn.execute('SELECT * FROM customers ORDER BY name')], 'orders': orders, 'summary': {'active': sum(o['status'] not in ('completed', 'cancelled') for o in orders), 'revenue': sum(o['amount'] for o in completed), 'commission': sum(o['commission'] for o in completed), 'commission_due': sum(o['commission_due'] for o in completed)}}

    def mutate(self, conn, username, method, path, data):
        parts = path.strip('/').split('/')
        if len(parts) not in (2, 3) or parts[1] not in ('customers', 'translators', 'orders'):
            return self.send(404, {'error': 'Действие не найдено.'})
        entity = parts[1]
        if (method == 'POST' and len(parts) != 2) or (method == 'PATCH' and len(parts) != 3):
            return self.send(404, {'error': 'Действие не найдено.'})
        item_id = int(parts[2]) if method == 'PATCH' else None
        existing = conn.execute(f'SELECT * FROM {entity} WHERE id=?', (item_id,)).fetchone() if item_id else None
        if method == 'PATCH' and not existing:
            return self.send(404, {'error': 'Запись не найдена.'})
        if entity == 'customers':
            values = {'name': string(data, 'name', True, 150), 'organization': string(data, 'organization', limit=200), 'phone': string(data, 'phone', limit=80)}
        elif entity == 'translators':
            languages = data.get('languages')
            if not isinstance(languages, list) or not 1 <= len(languages) <= 30 or any(not isinstance(v, str) or not v.strip() or len(v) > 80 for v in languages):
                raise ValueError('Укажите хотя бы один язык.')
            active = data.get('active', True)
            if not isinstance(active, bool):
                raise ValueError('Некорректный статус переводчика.')
            if not active and item_id and conn.execute("SELECT 1 FROM orders WHERE translator_id=? AND status IN ('assigned','in_progress')", (item_id,)).fetchone():
                raise ValueError('Сначала переназначьте активные заявки этого переводчика.')
            if item_id:
                supported = {v.strip().casefold() for v in languages}
                pending = conn.execute("SELECT language FROM orders WHERE translator_id=? AND status IN ('assigned','in_progress')", (item_id,))
                if any(row['language'].casefold() not in supported for row in pending):
                    raise ValueError('Нельзя удалить язык, пока есть назначенные заявки с этим языком.')
            values = {'name': string(data, 'name', True, 150), 'phone': string(data, 'phone', limit=80), 'languages': json.dumps(sorted(set(v.strip() for v in languages)), ensure_ascii=False), 'active': int(active)}
        else:
            merged = dict(existing) if existing else {'status': 'new', 'amount': '0', 'commission_paid': '0'}
            # API accepts rubles; stored monetary values are integer kopecks.
            if existing:
                merged['amount'] = str(Decimal(existing['amount']) / 100)
                merged['commission_paid'] = str(Decimal(existing['commission_paid']) / 100)
            merged.update(data)
            customer = record_id(merged.get('customer_id'))
            if not conn.execute('SELECT 1 FROM customers WHERE id=?', (customer,)).fetchone():
                raise ValueError('Выберите заказчика из базы.')
            language = string(merged, 'language', True, 80)
            status = merged.get('status', 'new')
            if status not in STATUSES:
                raise ValueError('Некорректный статус заявки.')
            translator = merged.get('translator_id')
            if translator:
                translator = record_id(translator)
                person = conn.execute('SELECT * FROM translators WHERE id=?', (translator,)).fetchone()
                historical = existing and status in ('completed', 'cancelled') and translator == existing['translator_id'] and language == existing['language']
                if not person or (not historical and (not person['active'] or language.casefold() not in [v.casefold() for v in json.loads(person['languages'])])):
                    raise ValueError('Выберите активного переводчика с нужным языком.')
            elif translator is not None:
                raise ValueError('Некорректный идентификатор переводчика.')
            if status in ('assigned', 'in_progress', 'completed') and not translator:
                raise ValueError('Сначала назначьте переводчика.')
            if status == 'new' and translator:
                raise ValueError('Для заявки с переводчиком выберите статус «Назначена».')
            amount = money(merged.get('amount', '0'))
            paid = money(merged.get('commission_paid', '0'))
            if paid > commission(amount):
                raise ValueError('Полученная комиссия превышает 30% стоимости.')
            if paid and status != 'completed':
                raise ValueError('Полученную комиссию можно указать после выполнения заявки.')
            scheduled = string(merged, 'scheduled_at', limit=30)
            if scheduled:
                try:
                    datetime.strptime(scheduled, '%Y-%m-%dT%H:%M')
                except ValueError:
                    raise ValueError('Проверьте дату и время заявки.') from None
            values = {'customer_id': customer, 'translator_id': translator, 'language': language, 'scheduled_at': scheduled, 'location': string(merged, 'location', limit=300), 'notes': string(merged, 'notes', limit=5000), 'status': status, 'amount': amount, 'commission_percent': 30, 'commission_paid': paid, 'updated_at': now()}
            if not existing:
                values['created_at'] = now()
        if existing:
            conn.execute(f"UPDATE {entity} SET {','.join(k+'=?' for k in values)} WHERE id=?", (*values.values(), item_id))
        else:
            item_id = conn.execute(f"INSERT INTO {entity} ({','.join(values)}) VALUES ({','.join('?' for _ in values)})", tuple(values.values())).lastrowid
        conn.execute('INSERT INTO audit(username,action,entity,entity_id,created_at) VALUES (?,?,?,?,?)', (username, method, entity, item_id, now()))
        conn.commit()
        self.send(200 if existing else 201, {'id': item_id})

    def export(self, conn):
        output = io.StringIO()
        writer = csv.writer(output, delimiter=';')
        writer.writerow(['Номер', 'Заказчик', 'Организация', 'Язык', 'Переводчик', 'Дата (Москва)', 'Статус', 'Стоимость, ₽', 'Комиссия, ₽', 'Получено, ₽', 'Долг, ₽'])
        def safe(value):
            text = str(value or '')
            return "'" + text if text.lstrip().startswith(('=', '+', '-', '@')) else text
        for row in self.snapshot(conn)['orders']:
            writer.writerow([row['id'], safe(row['customer_name']), safe(row['organization']), safe(row['language']), safe(row['translator_name']), row['scheduled_at'], row['status'], f"{row['amount']/100:.2f}", f"{row['commission']/100:.2f}", f"{row['commission_paid']/100:.2f}", f"{row['commission_due']/100:.2f}"])
        self.send(200, ('\ufeff' + output.getvalue()).encode(), 'text/csv; charset=utf-8', {'Content-Disposition': 'attachment; filename="liga-orders.csv"'})


def seed_demo(path):
    with connect(path) as conn:
        if conn.execute('SELECT 1 FROM customers LIMIT 1').fetchone() or conn.execute('SELECT 1 FROM translators LIMIT 1').fetchone():
            raise ValueError('Демо можно загрузить только в пустую базу.')
        customer = conn.execute('INSERT INTO customers(name,organization,phone) VALUES (?,?,?)', ('Учебный заказчик', 'Демонстрационная организация', '')).lastrowid
        interpreter = conn.execute('INSERT INTO translators(name,languages) VALUES (?,?)', ('Учебный переводчик', '["Английский", "Арабский"]')).lastrowid
        for language, status, amount, paid in [('Арабский', 'assigned', 800000, 0), ('Английский', 'completed', 1200000, 150000), ('Арабский', 'new', 500000, 0)]:
            conn.execute('INSERT INTO orders(customer_id,translator_id,language,status,amount,commission_paid,location,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)', (customer, interpreter if status != 'new' else None, language, status, amount, paid, 'Демонстрационная заявка', now(), now()))


def main():
    parser = argparse.ArgumentParser(description='CRM Лиги переводчиков')
    parser.add_argument('--db', default=os.environ.get('LIGA_DB', str(ROOT / 'data' / 'liga.sqlite3')))
    sub = parser.add_subparsers(dest='command', required=True)
    admin = sub.add_parser('init-admin', help='Создать администратора / сменить пароль')
    admin.add_argument('--username', default='admin')
    sub.add_parser('seed-demo', help='Загрузить вымышленные примеры в пустую базу')
    serve = sub.add_parser('serve')
    serve.add_argument('--host', default='127.0.0.1')
    serve.add_argument('--port', type=int, default=8000)
    serve.add_argument('--secure-cookie', action='store_true', help='Включить для HTTPS за обратным прокси')
    args = parser.parse_args()
    initialize(args.db)
    if args.command == 'init-admin':
        password = getpass.getpass('Пароль (минимум 12 символов): ')
        if password != getpass.getpass('Повторите пароль: '):
            parser.error('Пароли не совпадают.')
        set_admin(args.db, args.username, password)
        print('Администратор создан.')
    elif args.command == 'seed-demo':
        seed_demo(args.db)
        print('Вымышленные примеры добавлены.')
    else:
        with connect(args.db) as conn:
            if not conn.execute('SELECT 1 FROM admins LIMIT 1').fetchone():
                parser.error('Сначала выполните: python app.py init-admin')
        logging.basicConfig(level=logging.INFO)
        server = CRMServer((args.host, args.port), args.db, args.secure_cookie)
        print(f'CRM: http://{args.host}:{server.server_port}', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()


if __name__ == '__main__':
    main()
