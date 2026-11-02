import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startManagedWorkspaceTeam } from '../plugin/server/workflow-view.ts';
import { createDeskSeat } from '../plugin/server/desk-seat.ts';
import { createDeskStore, repoKeyFor } from '../plugin/server/desk-store.ts';

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'slp-bootstrap-workspace-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const home=join(root,'home');mkdirSync(home);
  writeFileSync(join(home,'config.json'),JSON.stringify({daemon:{agentProfiles:[{
    id:'slp-supervisor',provider:'slp-claude-supervisor',model:'claude-sonnet-5-5',
    modeId:'bypassPermissions',thinkingOptionId:'medium',featureValues:{fast:false},
  }]}}));
  const repo=join(root,'repo');mkdirSync(repo);
  execFileSync('git',['-C',repo,'init','-q']);
  execFileSync('git',['-C',repo,'config','user.name','Fixture']);
  execFileSync('git',['-C',repo,'config','user.email','fixture@example.invalid']);
  writeFileSync(join(repo,'file'),'x\n');
  execFileSync('git',['-C',repo,'add','.']);
  execFileSync('git',['-C',repo,'commit','-qm','fixture']);
  const previous=process.env.PASEO_HOME;
  process.env.PASEO_HOME=home;
  t.after(()=>{if(previous===undefined)delete process.env.PASEO_HOME;else process.env.PASEO_HOME=previous;});
  return {root,home,repo};
}

test('absent desk bootstraps a managed Supervisor in the existing workspace and preserves saved bypass mode',async t=>{
  const f=fixture(t);
  let created=null;
  const stableRoot=join(realpathSync(f.home),'slp-runtime');
  const seat=createDeskSeat({stableRoot,transactBudgetMs:5000});
  const host={workspaces:{ref(id){return {
    refresh:async()=>({id,workspaceDirectory:f.repo,archivingAt:null}),
    agents:{create:async options=>{
      created=options;
      const provider=options.config.provider.split('/',1)[0];
      const minted=await seat.deskMint({provider,family:'claude',role:'supervisor',cwd:f.repo,env:{}});
      assert.ok(minted,'managed Supervisor creation must mint the first desk seat');
      return{id:'agent-supervisor'};
    }},
  };}}};
  const out=await startManagedWorkspaceTeam({workspaceId:'wks-pr'},host);
  assert.equal(out.state,'started');
  assert.equal(out.agentId,'agent-supervisor');
  assert.ok(created);
  assert.equal(created.config.provider,'slp-claude-supervisor/claude-sonnet-5-5');
  assert.equal(created.config.modeId,'bypassPermissions');
  assert.equal(created.config.thinkingOptionId,'medium');
  assert.deepEqual(created.config.featureValues,{fast:false});
  assert.equal(created.title,'Equipes · Supervisor do workspace');
  assert.match(created.prompt,/workspace Git já existente/);
  assert.match(created.prompt,/PR/);
  assert.equal(created.labels['slp.bootstrap'],'workspace');
  const gitCommonDir=realpathSync(execFileSync('git',['-C',f.repo,'rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8'}).trim());
  const repoKey=repoKeyFor({hostId:'local',gitCommonDir});
  assert.equal(repoKey,out.repoKey);
  const stored=createDeskStore({stableRoot}).read(repoKey);
  assert.equal(stored.state,'ok','the first managed Supervisor seat must materialize the repository ledger');
  assert.equal(stored.ledger.memberships.length,1);
  assert.equal(stored.ledger.memberships[0].role,'supervisor');
});

test('invalid or missing saved Supervisor profile fails before native agent creation',async t=>{
  const f=fixture(t);
  writeFileSync(join(f.home,'config.json'),JSON.stringify({daemon:{agentProfiles:[]}}));
  let creates=0;
  const host={workspaces:{ref(id){return {
    refresh:async()=>({id,workspaceDirectory:f.repo,archivingAt:null}),
    agents:{create:async()=>{creates++;return{id:'bad'};}},
  };}}};
  await assert.rejects(startManagedWorkspaceTeam({workspaceId:'wks-pr'},host),/profile is unavailable/);
  assert.equal(creates,0);
});
