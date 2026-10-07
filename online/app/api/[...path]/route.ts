import { getChatGPTUser } from '../../chatgpt-auth';
import { getRawDb } from '../../../db';
import { handleCRM } from '../service';
export const dynamic = 'force-dynamic';
async function handle(request:Request) {
  return handleCRM(request,await getChatGPTUser(),getRawDb);
}
export const GET=handle;
export const POST=handle;
export const PATCH=handle;
