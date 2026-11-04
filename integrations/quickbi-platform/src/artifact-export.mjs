/** Safe, deterministic AIPro report/data export from an already-authorized artifact.
 * No database access or model call occurs during download.
 */
import { InputError } from './query.mjs';

function cell(value){
  if(value===null||value===undefined)return '';
  return typeof value==='object'?JSON.stringify(value):String(value);
}
function csvCell(value){
  let text=cell(value);
  // Spreadsheet formula injection: force dangerous user-controlled values to text.
  if(/^[\s\x00-\x1f]*[=+\-@]/.test(text))text=`'${text}`;
  return `"${text.replaceAll('"','""')}"`;
}
function csvRows(columns,rows){return [columns.map(csvCell).join(','),...rows.map(row=>columns.map(key=>csvCell(row[key])).join(','))].join('\r\n')+'\r\n';}
function markdownCell(value){return cell(value).replaceAll('\\','\\\\').replaceAll('|','\\|').replace(/\r?\n/g,' ');}
function textReport(item){
  const {content}=item,result=content.result??{},columns=result.columns??[],rows=result.rows??[];
  const table=columns.length?[`| ${columns.map(markdownCell).join(' | ')} |`,`| ${columns.map(()=>'---').join(' | ')} |`,...rows.map(row=>`| ${columns.map(key=>markdownCell(row[key])).join(' | ')} |`)].join('\n'):'（无表格数据）';
  const description=String(content.summary||'').replace(/\0/g,'');
  return `# ${item.name}\n\n${description}\n\n## 结果数据\n\n${table}\n\n---\n\n数据集 ID：${content.spec?.datasetId??'未知'}。该报告基于保存时的查询快照，不能证明因果关系。\n`;
}
export function exportArtifact(item,format='csv'){
  if(!['csv','md','json'].includes(format))throw new InputError('不支持的作品导出格式',400);
  if(!item?.content || !item.id)throw new InputError('作品数据无效',409);
  const result=item.content.result??{},columns=result.columns??[],rows=result.rows??[];
  if(!Array.isArray(columns)||columns.length>100||columns.some(x=>typeof x!=='string')||!Array.isArray(rows)||rows.length>1000)throw new InputError('作品结果格式不合法',409);
  const name=`analysis-${item.id}.${format}`;
  if(format==='csv')return {name,type:'text/csv; charset=utf-8',text:'\ufeff'+csvRows(columns,rows)};
  if(format==='md')return {name,type:'text/markdown; charset=utf-8',text:textReport(item)};
  return {name,type:'application/json; charset=utf-8',text:JSON.stringify({name:item.name,content:item.content},null,2)+'\n'};
}
