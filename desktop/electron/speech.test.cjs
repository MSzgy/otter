const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { SpeechPlayer } = require("./speech.cjs");
test("speech uses stdin and stopping a previous child does not stop the next state", () => {
  const children = [],
    states = [];
  const player = new SpeechPlayer({
    launch: (file, args) => {
      assert.equal(file, "/usr/bin/say");
      assert.deepEqual(args, []);
      const child = new EventEmitter();
      child.stdin = new EventEmitter();
      child.stdin.end = (t) => (child.text = t);
      child.stderr = new EventEmitter();
      child.kill = () => (child.killed = true);
      children.push(child);
      return child;
    },
    emit: (s) => states.push(s),
  });
  player.speak("First");
  player.speak("Second");
  assert(children[0].killed);
  children[0].emit("exit", 1);
  assert.equal(states.at(-1).speaking, true);
  assert.equal(children[1].text, "Second");
  player.stop();
  assert(children[1].killed);
  assert.equal(states.at(-1).speaking, false);
});
