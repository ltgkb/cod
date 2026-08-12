import assert from 'node:assert/strict';
import test from 'node:test';
import { isTaskboardReachable, normalizeTaskboardUrl, parseTaskboardRuntimeDescriptor, taskboardRuntimeCandidates } from '../dist/taskboard-url.js';

test('shows a taskboard only when its loopback entry point is reachable', async () => {
  let requestedUrl;let requestOptions;
  assert.equal(await isTaskboardReachable('http://127.0.0.1:47823/runtime-token',async(url,options)=>{requestedUrl=url.toString();requestOptions=options;return{ok:true};}),true);
  assert.equal(requestedUrl,'http://127.0.0.1:47823/runtime-token/');assert.equal(requestOptions.redirect,'manual');
  assert.equal(await isTaskboardReachable('http://127.0.0.1:47823/runtime-token',async()=>({ok:false})),false);
  assert.equal(await isTaskboardReachable('https://taskboard.example',async()=>({ok:true})),false);
});

test('accepts only credential-free loopback HTTP taskboard URLs',()=>{
  assert.equal(normalizeTaskboardUrl('http://127.0.0.1:47823'),'http://127.0.0.1:47823/');
  assert.equal(normalizeTaskboardUrl('http://localhost:47823/runtime-token'),'http://localhost:47823/runtime-token/');
  assert.equal(normalizeTaskboardUrl('http://[::1]:47823/board'),'http://[::1]:47823/board/');
  assert.equal(normalizeTaskboardUrl('https://127.0.0.1:47823'),null);
  assert.equal(normalizeTaskboardUrl('http://127.0.0.1.evil.example:47823'),null);
  assert.equal(normalizeTaskboardUrl('http://user:secret@127.0.0.1:47823'),null);
  assert.equal(normalizeTaskboardUrl('http://127.0.0.1:47823/#secret'),null);
});

test('uses only a live version-one runtime descriptor',()=>{
  const descriptor=JSON.stringify({version:1,pid:42,url:'http://127.0.0.1:47823/token'});
  assert.equal(parseTaskboardRuntimeDescriptor(descriptor,(pid)=>pid===42),'http://127.0.0.1:47823/token/');
  assert.equal(parseTaskboardRuntimeDescriptor(descriptor,()=>false),null);
  assert.equal(parseTaskboardRuntimeDescriptor(JSON.stringify({version:2,pid:42,url:'http://127.0.0.1:47823'}),()=>true),null);
});

test('uses an explicit absolute runtime descriptor and platform defaults',()=>{
  assert.deepEqual(taskboardRuntimeCandidates('/Users/tester','darwin','/tmp/taskboard-runtime.json'),['/tmp/taskboard-runtime.json']);
  assert.deepEqual(taskboardRuntimeCandidates('/Users/tester','darwin','relative.json'),[]);
  assert.deepEqual(taskboardRuntimeCandidates('/home/tester','linux'),['/home/tester/.codex/dashi-taskboard/.data/runtime.json']);
});
