import test from 'node:test';
import assert from 'node:assert/strict';
import {newSessionId,sessionFromCookie,sessionCookie,requireSameOrigin,sessionDigest} from '../src/console-auth.mjs';
test('session cookie is opaque, scoped and duplicate names rejected',()=>{const a=newSessionId(),b=newSessionId();assert.notEqual(a,b);assert.notEqual(sessionDigest(a),a);assert.equal(sessionFromCookie(sessionCookie(a)),a);assert.equal(sessionFromCookie(`synccut_session=${a}; synccut_session=${b}`),null);assert.match(sessionCookie(a),/HttpOnly; SameSite=Lax/);assert.match(sessionCookie(a),/Secure/)});
test('mutating requests reject missing or foreign Origin',()=>{assert.throws(()=>requireSameOrigin({headers:{}},'https://site.example'),/origin/);assert.throws(()=>requireSameOrigin({headers:{origin:'https://other.example'}},'https://site.example'),/origin/);assert.doesNotThrow(()=>requireSameOrigin({headers:{origin:'https://site.example'}},'https://site.example'));});
