import { displayTime } from './scheduling.js';
import { createHmac } from 'node:crypto';
import type { FeishuMessage } from '../../../../shared/src/feishu.js';
export function safeText(text:string):string {return String(text).replace(/</g,'＜').replace(/>/g,'＞').replace(/@/g,'＠').slice(0,600);}
export type TransportOutcome={outcome:'accepted'|'failed'|'unknown';retryable:boolean;message:string};
export async function deliverFeishuMessage(credentials:{webhook:string;secret:string},bot:{signatureEnabled:boolean;keyword:string},message:FeishuMessage,transport:typeof fetch,now:Date):Promise<TransportOutcome>{
 let url:URL;try{url=new URL(credentials.webhook);}catch{return {outcome:'failed',retryable:false,message:'机器人地址无效，请修复配置。'};}
 if(url.protocol!=='https:'||url.hostname!=='open.feishu.cn'||url.port||url.username||url.password||url.search||url.hash||!/^\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9_-]+$/.test(url.pathname))return {outcome:'failed',retryable:false,message:'机器人地址不在允许范围。'};
 const elements:unknown[]=[{tag:'div',text:{tag:'plain_text',content:[safeText(bot.keyword),safeText(message.projectName),...message.lines.slice(0,10).map(safeText),message.total>10?`共 ${message.total} 项，更多请在系统查看`:'',`统计时间：${displayTime(message.generatedAt)}`].filter(Boolean).join('\n')}}];
 if(message.mentionAll)elements.push({tag:'div',text:{tag:'lark_md',content:'<at id=all></at>'}});
 if(message.url)elements.push({tag:'action',actions:[{tag:'button',text:{tag:'plain_text',content:message.linkLabel},url:message.url,type:'primary'}]});
 const body:Record<string,unknown>={msg_type:'interactive',card:{config:{wide_screen_mode:true},header:{template:'blue',title:{tag:'plain_text',content:safeText(message.title)}},elements}};
 if(bot.signatureEnabled){if(!credentials.secret)return {outcome:'failed',retryable:false,message:'签名密钥缺失，请修复配置。'};const timestamp=String(Math.floor(now.getTime()/1000));body.timestamp=timestamp;body.sign=createHmac('sha256',`${timestamp}\n${credentials.secret}`).update('').digest('base64');}
 try {
  const response=await transport(url.toString(),{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10_000)});
  if(response.status>=300&&response.status<400)return {outcome:'failed',retryable:false,message:'飞书返回重定向，已停止。'};
  if(response.status===429)return {outcome:'failed',retryable:true,message:'飞书限流，稍后重试。'};
  if(response.status>=500)return {outcome:'unknown',retryable:false,message:'飞书服务异常，无法确认是否接收，请人工核对。'};
  if(!response.ok)return {outcome:'failed',retryable:false,message:'飞书拒绝请求，请检查机器人配置。'};
  let result:{code?:number;StatusCode?:number};try{result=await response.json() as typeof result;}catch{return {outcome:'unknown',retryable:false,message:'飞书响应无法解析，请人工核对。'};}
  const code=result.code??result.StatusCode;
  if(code===0)return {outcome:'accepted',retryable:false,message:'飞书已接收；请在目标群核对。'};
  if(typeof code!=='number')return {outcome:'unknown',retryable:false,message:'飞书未返回明确业务结果，请人工核对。'};
  const retryable=[99991400,99991401,11232].includes(code);
  return {outcome:'failed',retryable,message:retryable?'飞书暂时拒绝，稍后重试。':`飞书拒绝请求（${code}），请检查签名、关键词和机器人状态。`};
 }catch{return {outcome:'unknown',retryable:false,message:'请求中断或超时，无法确认是否送达；请核对目标群后再处理。'};}
}
