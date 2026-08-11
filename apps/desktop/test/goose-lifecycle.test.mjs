import assert from 'node:assert/strict';
import test from 'node:test';
import { GooseLaunchCoordinator, GooseLaunchInterruptedError } from '../dist/goose-lifecycle.js';

test('a lifecycle invalidation during delayed mint prevents a later spawn',async()=>{
  const coordinator=new GooseLaunchCoordinator();let releaseMint=()=>undefined;const mintGate=new Promise((resolve)=>{releaseMint=resolve;});let markMintStarted=()=>undefined;const mintStarted=new Promise((resolve)=>{markMintStarted=resolve;});let spawns=0;let stops=0;
  const launch=coordinator.run(async(assertCurrent)=>{markMintStarted();await mintGate;assertCurrent();spawns+=1;return 'started';});
  await mintStarted;const stopping=coordinator.invalidate(async()=>{stops+=1;});releaseMint();await assert.rejects(launch,GooseLaunchInterruptedError);await stopping;assert.equal(spawns,0);assert.equal(stops,1);
});

test('concurrent launch requests are serialized and cannot create overlapping sidecars',async()=>{
  const coordinator=new GooseLaunchCoordinator();let active=0;let maximumActive=0;let releaseFirst=()=>undefined;const firstGate=new Promise((resolve)=>{releaseFirst=resolve;});let markFirstStarted=()=>undefined;const firstStarted=new Promise((resolve)=>{markFirstStarted=resolve;});
  const first=coordinator.run(async(assertCurrent)=>{active+=1;maximumActive=Math.max(maximumActive,active);markFirstStarted();await firstGate;assertCurrent();active-=1;return 'first';});
  await firstStarted;const second=coordinator.run(async(assertCurrent)=>{assertCurrent();active+=1;maximumActive=Math.max(maximumActive,active);active-=1;return 'second';});releaseFirst();assert.deepEqual(await Promise.all([first,second]),['first','second']);assert.equal(maximumActive,1);
});
