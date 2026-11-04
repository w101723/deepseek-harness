/** Optional live read-only connector smoke test. Requires explicit credentials
 * and exact DATASOURCE_ALLOWED_HOSTS. Never logs secrets or query rows.
 *
 * QUICKBI_SMOKE_SOURCES='[{"kind":"postgres","host":"db.internal",...}]' npm run test:live
 */
import { validateConnection, encryptCredentials, testSource, sourceSchema, sourcePreview } from '../src/connectors.mjs';

let sources;
try {
  sources=JSON.parse(process.env.QUICKBI_SMOKE_SOURCES||'null');
} catch {throw new Error('QUICKBI_SMOKE_SOURCES must be a valid JSON array');}
if(!Array.isArray(sources)||sources.length===0)throw new Error('Specify QUICKBI_SMOKE_SOURCES JSON array of real read-only connections');
if(sources.length>8)throw new Error('At most eight live sources per smoke test');
let failed=false;
for(const [i,source] of sources.entries()) {
  const name=`source-${i+1} (${source.kind||'unknown'})`;
  try{
    const cfg=validateConnection(source);
    const sealed=encryptCredentials(cfg);
    const resource={kind:cfg.kind,connection_json:sealed};
    const check=await testSource(resource);
    if(!check.ok)throw new Error('connection test failed');
    const catalog=await sourceSchema(resource);
    if(!Array.isArray(catalog.tables))throw new Error('invalid metadata payload');
    const preview=await sourcePreview(resource);
    if(!Array.isArray(preview.rows)||preview.rows.length>15)throw new Error('preview row limit violated');
    console.log(`PASS ${name}: discovered ${catalog.tables.length} tables, preview ${preview.rows.length} rows`);
  }catch(e){
    failed=true;
    // Error descriptions may embed addresses or account names in driver messages;
    // never print the raw driver exception in a credential-bearing smoke script.
    console.error(`FAIL ${name}: ${e?.name||'ConnectorError'} (check database/network logs)`);
  }
}
if(failed)process.exitCode=1;
