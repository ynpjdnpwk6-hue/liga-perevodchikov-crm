import { sqliteTable, integer, text, index, uniqueIndex, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
export const customers = sqliteTable('customers', {
  id:integer('id').primaryKey({autoIncrement:true}), ownerId:text('owner_id').notNull(),
  name:text('name').notNull(), organization:text('organization').notNull().default(''), phone:text('phone').notNull().default(''), revision:integer('revision').notNull().default(1),
}, t=>[index('idx_customers_owner').on(t.ownerId)]);
export const league = sqliteTable('league', {
  id:integer('id').primaryKey(), ownerId:text('owner_id').notNull(),
},t=>[check('one_league',sql`${t.id} = 1`)]);
export const investigatorAccounts = sqliteTable('investigator_accounts', {
  id:integer('id').primaryKey({autoIncrement:true}),ownerId:text('owner_id').notNull(),
  email:text('email').notNull(),userId:text('user_id'),customerId:integer('customer_id').notNull().references(()=>customers.id),
  active:integer('active').notNull().default(1),revision:integer('revision').notNull().default(1),createdAt:text('created_at').notNull(),
},t=>[uniqueIndex('idx_investigator_email').on(t.ownerId,t.email),uniqueIndex('idx_investigator_user').on(t.ownerId,t.userId),check('investigator_active_boolean',sql`${t.active} IN (0,1)`)]);
export const phoneAccounts = sqliteTable('phone_accounts', {
  id:text('id').primaryKey(),ownerId:text('owner_id').notNull(),customerId:integer('customer_id').notNull().references(()=>customers.id),phone:text('phone').notNull(),passwordHash:text('password_hash').notNull(),recoveryHash:text('recovery_hash').notNull(),role:text('role').notNull().default('investigator'),active:integer('active').notNull().default(1),revision:integer('revision').notNull().default(1),createdAt:text('created_at').notNull(),
},t=>[uniqueIndex('idx_phone_number').on(t.phone),index('idx_phone_owner').on(t.ownerId),uniqueIndex('idx_owner_phone_admin').on(t.ownerId).where(sql`${t.role} = 'admin'`),check('phone_role',sql`${t.role} IN ('admin','investigator')`),check('phone_active',sql`${t.active} IN (0,1)`)]);
export const phoneSessions = sqliteTable('phone_sessions', {
  tokenHash:text('token_hash').primaryKey(),accountId:text('account_id').notNull().references(()=>phoneAccounts.id),createdAt:integer('created_at').notNull(),expiresAt:integer('expires_at').notNull(),
},t=>[index('idx_session_account').on(t.accountId),index('idx_session_expiry').on(t.expiresAt)]);
export const authLimits = sqliteTable('auth_limits', {
  key:text('key').primaryKey(),windowStart:integer('window_start').notNull(),attempts:integer('attempts').notNull(),expiresAt:integer('expires_at').notNull(),
});
export const translators = sqliteTable('translators', {
  id:integer('id').primaryKey({autoIncrement:true}),ownerId:text('owner_id').notNull(),name:text('name').notNull(),phone:text('phone').notNull().default(''),languages:text('languages').notNull(),languageKeys:text('language_keys').notNull(),active:integer('active').notNull().default(1),revision:integer('revision').notNull().default(1),
},t=>[index('idx_translators_owner').on(t.ownerId),check('active_boolean',sql`${t.active} IN (0,1)`)]);
export const orders = sqliteTable('orders', {
  id:integer('id').primaryKey({autoIncrement:true}),ownerId:text('owner_id').notNull(),customerId:integer('customer_id').notNull().references(()=>customers.id),requesterAccountId:integer('requester_account_id').references(()=>investigatorAccounts.id),requesterPhoneId:text('requester_phone_id').references(()=>phoneAccounts.id),translatorId:integer('translator_id').references(()=>translators.id),language:text('language').notNull(),scheduledAt:text('scheduled_at').notNull().default(''),location:text('location').notNull().default(''),notes:text('notes').notNull().default(''),requesterNotes:text('requester_notes').notNull().default(''),status:text('status').notNull().default('new'),amount:integer('amount').notNull().default(0),commissionPercent:integer('commission_percent').notNull().default(30),commissionPaid:integer('commission_paid').notNull().default(0),createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull(),revision:integer('revision').notNull().default(1),
},t=>[index('idx_orders_owner').on(t.ownerId),index('idx_orders_translator_status').on(t.translatorId,t.status),check('nonnegative_amount',sql`${t.amount} >= 0`),check('nonnegative_paid',sql`${t.commissionPaid} >= 0`),check('fixed_commission',sql`${t.commissionPercent} = 30`),check('valid_status',sql`${t.status} IN ('new','assigned','in_progress','completed','cancelled')`)]);
export const audit = sqliteTable('audit', {
  id:integer('id').primaryKey({autoIncrement:true}),ownerId:text('owner_id').notNull(),actorId:text('actor_id'),action:text('action').notNull(),entity:text('entity').notNull(),entityId:integer('entity_id').notNull(),createdAt:text('created_at').notNull(),
});
