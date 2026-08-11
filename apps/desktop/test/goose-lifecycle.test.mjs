import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { forceTerminateChildProcess, GooseLaunchCoordinator, GooseLaunchInterruptedError, terminateChildProcess } from '../dist/goose-lifecycle.js';

class FakeChildProcess extends EventEmitter {
  exitCode = null;
  signalCode = null;
  killed = false;
  signals = [];
  exitAfterSignal = true;

  kill(signal = 'SIGTERM') {
    this.killed = true;
    this.signals.push(signal);
    if (this.exitAfterSignal) queueMicrotask(() => {
      this.signalCode = signal;
      this.emit('exit', 0, signal);
    });
    return true;
  }
}

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

test('terminates the captured sidecar even when its exit listener clears the shared reference', async () => {
  const sidecar = new FakeChildProcess();
  let sharedSidecar = sidecar;
  sidecar.once('exit', () => { sharedSidecar = null; });
  await terminateChildProcess(sidecar);
  assert.equal(sharedSidecar, null);
  assert.deepEqual(sidecar.signals, ['SIGTERM']);
});

test('escalates an unresponsive sidecar and supports synchronous process-exit cleanup', async () => {
  const unresponsive = new FakeChildProcess();
  unresponsive.exitAfterSignal = false;
  await terminateChildProcess(unresponsive, 1);
  assert.deepEqual(unresponsive.signals, ['SIGTERM', 'SIGKILL']);

  const exiting = new FakeChildProcess();
  exiting.exitAfterSignal = false;
  forceTerminateChildProcess(exiting);
  assert.deepEqual(exiting.signals, ['SIGKILL']);
});

test('does not signal a child again after it exited because of a signal', async () => {
  const exited = new FakeChildProcess();
  exited.signalCode = 'SIGTERM';
  await terminateChildProcess(exited, 1);
  forceTerminateChildProcess(exited);
  assert.deepEqual(exited.signals, []);
});
