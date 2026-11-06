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
