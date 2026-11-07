import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { companyContextForCwd } from '../plugin/server/company-context.ts';
const sha=v=>createHash('sha256').update(v).digest('hex');

test('corporate policy follows git-common-dir into a PR worktree outside protected roots',t=>{
  const root=mkdtempSync(join(tmpdir(),'slp-company-worktree-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const protectedRoot=join(root,'Projetos','Fourtime');mkdirSync(protectedRoot,{recursive:true});
  const repo=join(protectedRoot,'DWLaw','api');mkdirSync(repo,{recursive:true});
  execFileSync('git',['-C',repo,'init','-q']);execFileSync('git',['-C',repo,'config','user.name','Fixture']);execFileSync('git',['-C',repo,'config','user.email','fixture@example.invalid']);
  writeFileSync(join(repo,'file'),'x\n');execFileSync('git',['-C',repo,'add','.']);execFileSync('git',['-C',repo,'commit','-qm','fixture']);
  const remote='https://example.invalid/dwlaw-api.git';execFileSync('git',['-C',repo,'remote','add','origin',remote]);
  const worktree=join(root,'worktrees','pr-1975');mkdirSync(join(root,'worktrees'),{recursive:true});
  execFileSync('git',['-C',repo,'worktree','add','-qb','pr-1975',worktree]);
  const common=realpathSync(join(repo,'.git'));
  const registry=join(root,'companies.json');
  writeFileSync(registry,JSON.stringify({version:1,protectedRoots:[protectedRoot],
    companies:{DWLaw:{instructions:'Regra DWLaw de PR e pipeline.',sourceNotes:['Projetos/DWLaw/_mapa.md']}},
    projects:[{company:'DWLaw',project:'DWLaw/api',gitCommonDir:common,originSha256:sha(remote)}]}));
  const text=companyContextForCwd(worktree,registry);
  assert.match(text,/DWLaw \/ DWLaw\/api/);
  assert.match(text,/Regra DWLaw de PR/);
});

test('client container folder (non-git) binds its single company; unrelated protected folder stays unverified',t=>{
  const root=mkdtempSync(join(tmpdir(),'slp-company-container-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const protectedRoot=join(root,'Projetos','Fourtime');const container=join(protectedRoot,'DWLaw');const other=join(protectedRoot,'Outra');
  mkdirSync(container,{recursive:true});mkdirSync(other,{recursive:true});
  const common=join(realpathSync(container),'api','.git');
  const registry=join(root,'companies.json');
  writeFileSync(registry,JSON.stringify({version:1,protectedRoots:[protectedRoot],
    companies:{DWLaw:{instructions:'Regra DWLaw.',sourceNotes:['Projetos/DWLaw/_mapa.md']}},
    projects:[{company:'DWLaw',project:'DWLaw/api',gitCommonDir:common,originSha256:sha('x')}]}));
  assert.match(companyContextForCwd(container,registry),/DWLaw \/ \(pasta do cliente\)/);
  assert.throws(()=>companyContextForCwd(other,registry),/unverified/);
});

// --- instructions opcional (regras moram no Cérebro; o mapa guarda só vínculo + sourceNotes) ---
function fixture(t,prefix){
  const root=mkdtempSync(join(tmpdir(),prefix));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const protectedRoot=join(root,'Projetos','Fourtime');const repo=join(protectedRoot,'DWLaw','api');mkdirSync(repo,{recursive:true});
  execFileSync('git',['-C',repo,'init','-q']);execFileSync('git',['-C',repo,'config','user.name','Fixture']);execFileSync('git',['-C',repo,'config','user.email','fixture@example.invalid']);
  writeFileSync(join(repo,'file'),'x\n');execFileSync('git',['-C',repo,'add','.']);execFileSync('git',['-C',repo,'commit','-qm','fixture']);
  const remote='https://example.invalid/dwlaw-api.git';execFileSync('git',['-C',repo,'remote','add','origin',remote]);
  const common=realpathSync(join(repo,'.git'));const registry=join(root,'companies.json');
  const write=(policy,extra={})=>writeFileSync(registry,JSON.stringify({version:1,protectedRoots:[protectedRoot],companies:{DWLaw:policy},
    projects:[{company:'DWLaw',project:'DWLaw/api',gitCommonDir:common,originSha256:sha(extra.remote??remote)}]}));
  return {root,protectedRoot,repo,registry,write,common,remote};
}
const NOTES=['Projetos/DWLaw/_mapa.md'];

test('instructions absent: repository gets verified binding, isolation notice and sourceNotes only',t=>{
  const f=fixture(t,'slp-company-noinstr-');f.write({sourceNotes:NOTES});
  const text=companyContextForCwd(f.repo,f.registry);
  assert.match(text,/DWLaw \/ DWLaw\/api/);
  assert.match(text,/nunca herdar políticas/);
  assert.match(text,/Projetos\/DWLaw\/_mapa\.md/);
});

test('instructions absent: PR worktree outside protected root and client container still bind',t=>{
  const f=fixture(t,'slp-company-noinstr-wt-');f.write({sourceNotes:NOTES});
  const wt=join(f.root,'worktrees','pr-1');mkdirSync(join(f.root,'worktrees'),{recursive:true});
  execFileSync('git',['-C',f.repo,'worktree','add','-qb','pr-1',wt]);
  assert.match(companyContextForCwd(wt,f.registry),/DWLaw \/ DWLaw\/api/);
  assert.match(companyContextForCwd(join(f.protectedRoot,'DWLaw'),f.registry),/DWLaw \/ \(pasta do cliente\)/);
});

test('instructions empty or whitespace is treated as absent',t=>{
  const f=fixture(t,'slp-company-emptyinstr-');
  for(const value of ['','   \n']){
    f.write({instructions:value,sourceNotes:NOTES});
    const text=companyContextForCwd(f.repo,f.registry);
    assert.match(text,/DWLaw \/ DWLaw\/api/);
    assert.doesNotMatch(text,/\n\s*\n\s*\n/);
  }
});

test('instructions present is still validated and appended',t=>{
  const f=fixture(t,'slp-company-instr-');
  f.write({instructions:'  Regra DWLaw X.  ',sourceNotes:NOTES});
  assert.match(companyContextForCwd(f.repo,f.registry),/\nRegra DWLaw X\.\n/);
  f.write({instructions:'a'.repeat(2201),sourceNotes:NOTES});
  assert.throws(()=>companyContextForCwd(f.repo,f.registry),/missing or invalid/);
});

test('instructions of wrong type is invalid (number, object, array, null)',t=>{
  const f=fixture(t,'slp-company-badinstr-');
  for(const value of [5,{a:1},['x'],null,true]){
    f.write({instructions:value,sourceNotes:NOTES});
    assert.throws(()=>companyContextForCwd(f.repo,f.registry),/missing or invalid/,JSON.stringify(value));
  }
});

test('sourceNotes stays mandatory and bounded; policy must exist',t=>{
  const f=fixture(t,'slp-company-notes-');
  for(const policy of [{},{instructions:'ok'},{sourceNotes:'x'},{sourceNotes:[1]},{sourceNotes:['a'.repeat(241)]}]){
    f.write(policy);
    assert.throws(()=>companyContextForCwd(f.repo,f.registry),/missing or invalid/,JSON.stringify(policy));
  }
  writeFileSync(f.registry,JSON.stringify({version:1,protectedRoots:[f.protectedRoot],companies:{},
    projects:[{company:'DWLaw',project:'DWLaw/api',gitCommonDir:f.common,originSha256:sha(f.remote)}]}));
  assert.throws(()=>companyContextForCwd(f.repo,f.registry),/missing or invalid/);
});

test('identity checks unchanged without instructions: origin drift and unregistered repo fail',t=>{
  const f=fixture(t,'slp-company-ident-');
  f.write({sourceNotes:NOTES},{remote:'https://example.invalid/other.git'});
  assert.throws(()=>companyContextForCwd(f.repo,f.registry),/remote identity drift/);
  writeFileSync(f.registry,JSON.stringify({version:1,protectedRoots:[f.protectedRoot],companies:{DWLaw:{sourceNotes:NOTES}},projects:[]}));
  assert.throws(()=>companyContextForCwd(f.repo,f.registry),/not uniquely registered/);
});
