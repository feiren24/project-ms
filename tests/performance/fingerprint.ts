import { createHash } from 'node:crypto';
import { existsSync,readdirSync,readFileSync,statSync } from 'node:fs';
import { resolve,relative } from 'node:path';
/** Content hashes include untracked source files, unlike git diff alone. */
export function fingerprint(root:string,paths:string[]){const files:string[]=[];const visit=(path:string)=>{if(!existsSync(path))return;if(statSync(path).isDirectory()){for(const name of readdirSync(path).sort())if(!['node_modules','results','.git','test-results'].includes(name))visit(resolve(path,name));}else files.push(path);};for(const path of paths)visit(resolve(root,path));const hash=createHash('sha256');for(const file of files.sort())hash.update(relative(root,file)).update('\0').update(readFileSync(file)).update('\0');return {sha256:hash.digest('hex'),fileCount:files.length};}
