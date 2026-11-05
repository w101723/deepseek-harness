import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {parseSelect} from '../src/asset-manager.mjs';
import {openDatabase,id} from '../src/db.mjs';
import {encryptCredentials} from '../src/connectors.mjs';
import {compileExternalQuery} from '../src/query-external.mjs';

process.env.DATASOURCE_MASTER_KEY=randomBytes(32).toString('hex');
process.env.DATASOURCE_ALLOWED_HOSTS='localhost';

test('SQL dataset parses WHERE safely and rejects executable syntax',()=>{
  const p=parseSelect("SELECT amount FROM analytics.orders WHERE region = 'O''Reilly' AND amount >= 10.5;");
  assert.deepEqual(p.predicates,[{field:'region',op:'eq',value:"O'Reilly"},{field:'amount',op:'gte',value:10.5}]);
  for(const s of [
    'SELECT * FROM analytics.orders',
    'SELECT amount FROM analytics.orders WHERE 1=1',
    "SELECT amount FROM analytics.orders WHERE region='east' OR amount>0",
    'SELECT amount FROM analytics.orders; DROP TABLE analytics.orders',
    'SELECT amount FROM analytics.orders WHERE amount IN (1,2)',
    'SELECT amount FROM analytics.orders WHERE amount = 1 AND',
  ])assert.throws(()=>parseSelect(s),undefined,s);
});

test('Immutable SQL dataset filters are bound and unprojected source fields stay hidden',()=>{
  const db=openDatabase(':memory:',{demoMode:true});
  try{
    const user=db.prepare("SELECT tenant_id,user_id FROM memberships WHERE role='admin'").get();
    const ctx={tenantId:user.tenant_id,userId:user.user_id,role:'admin'};
    const workspace=db.prepare('SELECT id FROM workspaces WHERE tenant_id=?').get(ctx.tenantId).id;
    const sourceId=id(),datasetId=id();
    const credentials=encryptCredentials({kind:'mysql',host:'localhost',port:3306,database:'analytics',user:'ro',password:'demo',ssl:false});
    db.prepare('INSERT INTO datasources(id,tenant_id,workspace_id,name,kind,connection_json) VALUES(?,?,?,?,?,?)').run(sourceId,ctx.tenantId,workspace,'SQL source','mysql',credentials);
    db.prepare('INSERT INTO datasets(id,tenant_id,workspace_id,datasource_id,name,dimensions_json,metrics_json) VALUES(?,?,?,?,?,?,?)').run(datasetId,ctx.tenantId,workspace,sourceId,'east',JSON.stringify(['amount']),JSON.stringify(['sum_amount','rows']));
    const select=parseSelect("SELECT amount FROM analytics.orders WHERE region = 'east' AND amount >= 10");
    const model={schema:'analytics',table:'orders',dimensions:['amount'],metrics:{sum_amount:{kind:'sum',column:'amount'},rows:{kind:'count'}},baseFilters:select.predicates,sourceColumns:['region','amount']};
    db.prepare('INSERT INTO external_dataset_models(dataset_id,schema_name,table_name,definition_json) VALUES(?,?,?,?)').run(datasetId,'analytics','orders',JSON.stringify(model));
    const compiled=compileExternalQuery(db,ctx,{datasetId,dimensions:['amount'],metrics:['sum_amount'],filters:[{field:'amount',op:'lte',value:99}],limit:5});
    assert.deepEqual(compiled.params,['east',10,99,5]);
    assert.match(compiled.sql,/WHERE \`region\` = \? AND \`amount\` >= \? AND \`amount\` <= \?/);
    assert.ok(!compiled.sql.includes("'east'"));
    assert.throws(()=>compileExternalQuery(db,ctx,{datasetId,dimensions:['region'],metrics:['rows']}));
  }finally{db.close();}
});
