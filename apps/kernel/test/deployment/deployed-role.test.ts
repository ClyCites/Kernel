import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { uuidv7 } from 'uuidv7';

import { INSUFFICIENT_PRIVILEGE, sqlState } from '../helpers/database.js';

const appUrl = process.env.DEPLOY_APP_DATABASE_URL;
const migratorUrl = process.env.DEPLOY_MIGRATOR_DATABASE_URL;
const enabled = appUrl !== undefined || migratorUrl !== undefined;

let app: Pool;
let migrator: Pool;

describe('deployed application role', { skip: !enabled }, () => {
  before(async () => {
    assert.ok(appUrl, 'DEPLOY_APP_DATABASE_URL is required');
    assert.ok(migratorUrl, 'DEPLOY_MIGRATOR_DATABASE_URL is required');
    app = new Pool({ connectionString: appUrl, max: 1 });
    migrator = new Pool({ connectionString: migratorUrl, max: 1 });
    await Promise.all([app.query('select 1'), migrator.query('select 1')]);
  });

  after(async () => {
    await Promise.all([app.end(), migrator.end()]);
  });

  test('is restricted and distinct from the migration role', async () => {
    const appIdentity = await app.query<{
      role: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
    }>(
      `select current_user role, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
         from pg_roles
        where rolname = current_user`,
    );
    const role = appIdentity.rows[0];
    assert.ok(role, 'current application role must be visible in pg_roles');
    assert.deepEqual(
      {
        rolsuper: role.rolsuper,
        rolbypassrls: role.rolbypassrls,
        rolcreatedb: role.rolcreatedb,
        rolcreaterole: role.rolcreaterole,
      },
      {
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
      },
    );

    const migrationIdentity = await migrator.query<{ role: string }>(
      'select current_user role',
    );
    assert.notEqual(migrationIdentity.rows[0]?.role, role.role);
  });

  test('has exactly INSERT and SELECT on append-only tables', async () => {
    const grants = await app.query<{
      table_schema: string;
      table_name: string;
      privilege_type: string;
    }>(
      `select table_schema, table_name, privilege_type
         from information_schema.role_table_grants
        where grantee = current_user
          and (table_schema, table_name) in (
            ('facts', 'record'),
            ('inference', 'record'),
            ('kernel', 'record_key')
          )
        order by table_schema, table_name, privilege_type`,
    );

    const byTable = new Map<string, string[]>();
    for (const row of grants.rows) {
      const table = `${row.table_schema}.${row.table_name}`;
      byTable.set(table, [...(byTable.get(table) ?? []), row.privilege_type]);
    }

    for (const table of [
      'facts.record',
      'inference.record',
      'kernel.record_key',
    ]) {
      assert.deepEqual(byTable.get(table), ['INSERT', 'SELECT'], table);
    }
  });

  test('can append but PostgreSQL refuses UPDATE', async () => {
    const client = await app.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into facts.record (
           id, type, record_class, schema_version,
           occurred_at, occurred_at_precision, recorded_at,
           asserted_by, body, lawful_basis
         ) values ($1, 'delivery', 'observation', '0.3.0',
                   now(), 'day', now(), $2, '{}', 'special_data_consent')`,
        [uuidv7(), uuidv7()],
      );
    } finally {
      await client.query('rollback');
      client.release();
    }

    const error = await app
      .query("update facts.record set type = 'x'")
      .then(
        () => null,
        (reason: unknown) => reason,
      );
    assert.equal(sqlState(error), INSUFFICIENT_PRIVILEGE);
  });
});