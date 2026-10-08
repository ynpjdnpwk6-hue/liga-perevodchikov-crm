export type Identity = {userId:string;displayName:string;email:string};
export type Access = {role:'admin'|'investigator';ownerId:string;account?:any};
export const PENDING_OWNER='liga-public-pending';

// Identity comes exclusively from the platform's trusted authenticated headers.
// The league is initialized by the configured owner, never by a first visitor.
export async function resolveAccess(db:D1Database,user:Identity,adminEmail:string):Promise<Access|null> {
  if(!adminEmail)return null;
  const email=user.email.trim().toLowerCase();
  if(email===adminEmail.trim().toLowerCase()) {
    await db.batch([db.prepare('INSERT INTO league(id,owner_id) VALUES(1,?) ON CONFLICT(id) DO NOTHING').bind(user.userId)]);
    const league=await db.prepare('SELECT owner_id FROM league WHERE id=1').first<any>();
    if(league?.owner_id!==user.userId)return null;
    // Public registrations can arrive before the owner's first visit. Only the
    // verified owner may adopt these new rows; existing owner-scoped rows stay intact.
    await db.batch(['customers','orders','phone_accounts','audit'].map(table=>db.prepare(`UPDATE ${table} SET owner_id=? WHERE owner_id=? AND EXISTS(SELECT 1 FROM league WHERE id=1 AND owner_id=?)`).bind(user.userId,PENDING_OWNER,user.userId)));
    return {role:'admin',ownerId:league.owner_id};
  }
  const league=await db.prepare('SELECT owner_id FROM league WHERE id=1').first<any>();
  if(!league)return null;
  await db.batch([db.prepare('UPDATE investigator_accounts SET user_id=? WHERE owner_id=? AND email=? AND active=1 AND (user_id IS NULL OR user_id=?)').bind(user.userId,league.owner_id,email,user.userId)]);
  const account=await db.prepare('SELECT a.id,a.customer_id,a.email,c.name,c.organization,c.phone FROM investigator_accounts a JOIN customers c ON c.id=a.customer_id AND c.owner_id=a.owner_id WHERE a.owner_id=? AND a.email=? AND a.user_id=? AND a.active=1').bind(league.owner_id,email,user.userId).first<any>();
  return account?{role:'investigator',ownerId:league.owner_id,account}:null;
}
