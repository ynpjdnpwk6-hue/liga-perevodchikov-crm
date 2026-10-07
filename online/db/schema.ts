import { sqliteTable, integer, text, index, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
export const customers = sqliteTable('customers', {
  id:integer('id').primaryKey({autoIncrement:true}), ownerId:text('owner_id').notNull(),
  name:text('name').notNull(), organization:text('organization').notNull().default(''), phone:text('phone').notNull().default(''), revision:integer('revision').notNull().default(1),
}, t=>[index('idx_customers_owner').on(t.ownerId)]);
export const translators = sqliteTable('translators', {
  id:integer('id').primaryKey({autoIncrement:true}),ownerId:text('owner_id').notNull(),name:text('name').notNull(),phone:text('phone').notNull().default(''),languages:text('languages').notNull(),languageKeys:text('language_keys').notNull(),active:integer('active').notNull().default(1),revision:integer('revision').notNull().default(1),
},t=>[index('idx_translators_owner').on(t.ownerId),check('active_boolean',sql`${t.active} IN (0,1)`)]);
export const orders = sqliteTable('orders', {
  id:integer('id').primaryKey({autoIncrement:true}),ownerId:text('owner_id').notNull(),customerId:integer('customer_id').notNull().references(()=>customers.id),translatorId:integer('translator_id').references(()=>translators.id),language:text('language').notNull(),scheduledAt:text('scheduled_at').notNull().default(''),location:text('location').notNull().default(''),notes:text('notes').notNull().default(''),status:text('status').notNull().default('new'),amount:integer('amount').notNull().default(0),commissionPercent:integer('commission_percent').notNull().default(30),commissionPaid:integer('commission_paid').notNull().default(0),createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull(),revision:integer('revision').notNull().default(1),
},t=>[index('idx_orders_owner').on(t.ownerId),index('idx_orders_translator_status').on(t.translatorId,t.status),check('nonnegative_amount',sql`${t.amount} >= 0`),check('nonnegative_paid',sql`${t.commissionPaid} >= 0`),check('fixed_commission',sql`${t.commissionPercent} = 30`),check('valid_status',sql`${t.status} IN ('new','assigned','in_progress','completed','cancelled')`)]);
export const audit = sqliteTable('audit', {
  id:integer('id').primaryKey({autoIncrement:true}),ownerId:text('owner_id').notNull(),action:text('action').notNull(),entity:text('entity').notNull(),entityId:integer('entity_id').notNull(),createdAt:text('created_at').notNull(),
});
