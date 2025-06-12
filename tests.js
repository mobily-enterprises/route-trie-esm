// File: trie_test_suite.js
// A comprehensive test suite for the Trie Router.
// This file IMPORTS the Trie from index.js and runs tests against it.
// To run: `node trie_test_suite.js`

'use strict';

// --- 1. Dependencies (ESM Syntax) ---
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';

// --- 2. Import the Router Code to be Tested ---
// This assumes your Trie implementation is in 'index.js' in the same directory.
import { Trie } from './index.js';


// --- 3. The Test Suite ---

describe('trie.define', () => {
    test('root pattern', () => {
        const trie = new Trie();
        const node = trie.define('/');
        assert.strictEqual(trie.define(''), node, 'Defining "" should return the root node');
        assert.strictEqual(node.pattern, '/', 'Root pattern should be "/"');
        assert.strictEqual(node.name, '', 'Root name should be empty');
        assert.strictEqual(node.parent, trie.root, 'Root parent should be the trie.root object');
        assert.strictEqual(trie.root.parent, null, 'The absolute root has no parent');
    });

    test('simple pattern', () => {
        const trie = new Trie();
        const node = trie.define('/a/b');
        assert.strictEqual(node.name, '', 'Node name should be empty');
        assert.strictEqual(node.pattern, '/a/b', 'Node pattern should be set correctly');
        assert.strictEqual(node, trie.define('a/b'), 'Defining without leading slash should yield the same node');
        assert.notStrictEqual(node, trie.define('/a/b/'), 'Trailing slash should create a different node');
        const parent = trie.define('/a');
        assert.strictEqual(node.parent, parent, 'Parent node should be correct');
        const child = trie.define('/a/b/c');
        assert.strictEqual(child.parent, node, 'Child node parent should be correct');
    });

    test('double colon pattern for escaping', () => {
        const trie = new Trie();
        const node = trie.define('/a/::b');
        assert.strictEqual(node.name, '', 'Escaped pattern should have no name');
        assert.strictEqual(trie.define('/a/::b'), node);
        assert.ok(trie.match('/a/:b').node, 'Path with single colon should match escaped pattern');
        assert.strictEqual(trie.match('/a/::b').node, null, 'Path with double colon should not match');
    });
    
    test('named pattern validation and structure', () => {
        const trie = new Trie();
        assert.throws(() => trie.define('/a/:'), 'Should throw for empty param name');
        assert.throws(() => trie.define('/a/:/'), 'Should throw for empty param name with slash');
        const node = trie.define('/a/:b');
        assert.strictEqual(node.name, 'b');
        assert.strictEqual(node.wildcard, false);
        assert.strictEqual(node.pattern, '/a/:b');
        assert.throws(() => trie.define('/a/:x'), 'Should throw for conflicting param name');
    });

    test('named pattern with suffix', () => {
        const trie = new Trie();
        assert.throws(() => trie.define('/a/:+'), 'Should throw for empty suffix');
        const node1 = trie.define('/a/:b+:undelete');
        assert.strictEqual(node1.name, 'b');
        // FIX: The suffix is the literal string after the '+', which includes the colon.
        assert.strictEqual(node1.suffix, ':undelete', 'Suffix should be correctly parsed');
        assert.throws(() => trie.define('/a/:x+:undelete'), 'Should throw for conflicting param name with same suffix');
    });

    test('wildcard pattern', () => {
        const trie = new Trie();
        assert.throws(() => trie.define('/a/*'), 'Should throw for invalid wildcard syntax');
        const node = trie.define('/a/:b*');
        assert.strictEqual(node.name, 'b');
        assert.strictEqual(node.wildcard, true);
        assert.throws(() => trie.define('/a/:x*'), 'Should throw for conflicting wildcard name');
        assert.throws(() => trie.define('/a/:b*/c'), 'Cannot define path after a wildcard');
    });

    test('regexp pattern', () => {
        const trie = new Trie();
        assert.throws(() => trie.define('/a/:()'), 'Should throw for empty regex');
        const node = trie.define('/a/:b(x|y)');
        assert.strictEqual(node.name, 'b');
        assert.ok(node.regex instanceof RegExp);
        assert.strictEqual(node.regex.toString(), '/x|y/');
    });

    test('complex pattern definition and priority sorting', () => {
        const trie = new Trie();
        const p = trie.define('/a');
        const n1 = trie.define('/a/:b'); // priority 2
        const n2 = trie.define('/a/:c(x|y)'); // priority 3
        const n3 = trie.define('/a/:d+suffix'); // priority 4
        const n4 = trie.define('/a/:w*'); // priority 1
        const n5 = trie.define('/a/:e(a+)+a2'); // priority 7 (4+3)
        
        const expectedPriorities = [7, 4, 3, 2, 1];
        const actualPriorities = p.varyChildren.map(c => c.priority);
        assert.deepStrictEqual(actualPriorities, expectedPriorities);
    });
});

describe('trie.match', () => {
    let trie;
    before(() => {
        trie = new Trie();
        trie.define('/');
        trie.define('/a/b');
        trie.define('/a/::b');
        trie.define('/a/:b');
        trie.define('/a/:b(x|y|z)');
        trie.define('/a/:b+:del');
        trie.define('/wild/:card*');
    });
    
    test('should match basic static and dynamic routes', () => {
        assert.ok(trie.match('/').node, 'Should match root');
        assert.ok(trie.match('/a/b').node, 'Should match static nested');
        assert.deepStrictEqual(trie.match('/a/anything').params, { b: 'anything' });
    });

    test('should respect regexp constraints', () => {
        assert.ok(trie.match('/a/x').node, 'Should match regex with "x"');
        assert.strictEqual(trie.match('/a/x').params.b, 'x');
        assert.strictEqual(trie.match('/a/w').node.segment, ':b', 'Should fall back to general param');
    });

    test('should match suffix patterns', () => {
        const m = trie.match('/a/file:del');
        assert.ok(m.node);
        assert.strictEqual(m.params.b, 'file');
    });

    test('should match wildcard patterns', () => {
        let m = trie.match('/wild/card/1/2/3');
        assert.ok(m.node);
        assert.strictEqual(m.params.card, 'card/1/2/3');
        m = trie.match('/wild/card');
        assert.ok(m.node);
        assert.strictEqual(m.params.card, 'card');
    });

    test('should handle options correctly', () => {
        const caseTrie = new Trie({ ignoreCase: true });
        caseTrie.define('/Users/Profile');
        assert.ok(caseTrie.match('/users/profile').node);

        const tsrTrie = new Trie({ trailingSlashRedirect: true });
        tsrTrie.define('/test');
        assert.strictEqual(tsrTrie.match('/test/').tsr, '/test');

        const fprTrie = new Trie({ fixedPathRedirect: true });
        fprTrie.define('/test/path');
        assert.strictEqual(fprTrie.match('/test//path').fpr, '/test/path');
    });
});

describe('trie.remove', () => {
    test('should remove a static leaf node', () => {
        const trie = new Trie();
        trie.define('/a');
        trie.define('/a/b');
        assert.ok(trie.match('/a/b').node, 'Node /a/b should exist before removal');
        trie.remove('/a/b');
        assert.strictEqual(trie.match('/a/b').node, null, 'Node /a/b should be removed');
        assert.ok(trie.match('/a').node, 'Parent node /a should still exist');
    });

    test('should remove a dynamic leaf node', () => {
        const trie = new Trie();
        trie.define('/a');
        trie.define('/a/:c');
        trie.define('/a/:d*');
        const parent = trie.define('/a');
        assert.strictEqual(parent.varyChildren.length, 2, 'Parent should have 2 dynamic children before');
        trie.remove('/a/:c');
        assert.strictEqual(trie.match('/a/test').node.segment, ':d*', 'Should match wildcard after normal param is removed');
        assert.strictEqual(parent.varyChildren.length, 1, 'Parent should have 1 dynamic child after');
    });

    test('should deactivate an endpoint without removing the node if it has children', () => {
        const trie = new Trie();
        trie.define('/a');
        trie.define('/a/b');
        const nodeA = trie.match('/a').node;
        assert.ok(nodeA.endpoint, '/a should be an endpoint before removal');
        trie.remove('/a');
        assert.strictEqual(trie.match('/a').node, null, '/a should no longer be a matchable endpoint');
        assert.ok(trie._findNode('/a'), 'The node for /a should still exist structurally');
        assert.ok(trie.match('/a/b').node, 'Child /a/b should still exist');
    });
});

describe('Node Handlers', () => {
    test('should handle methods and allows correctly', () => {
        const trie = new Trie();
        const handler1 = () => {};
        const handler2 = () => {};
        assert.throws(() => trie.define('/').handle('GET', null), 'Should not allow null handler');
        
        const node = trie.define('/');
        node.handle('GET', handler1);
        node.handle('POST', handler2);
        
        assert.throws(() => node.handle('GET', handler1), 'Should not allow redefining handler for same method');
        assert.strictEqual(node.getHandler('GET'), handler1);
        assert.strictEqual(node.getHandler('POST'), handler2);
        assert.strictEqual(node.getAllow(), 'GET, POST');
    });
});

// --- New Edge Case Tests ---

describe('Advanced Conflict Resolution', () => {
    test('should allow different dynamic types at the same level', () => {
        const trie = new Trie();
        assert.doesNotThrow(() => {
            trie.define('/c/:id');
            trie.define('/c/:id(^[0-9]+$)');
            trie.define('/c/:id+del');
        });
    });

    test('should throw on identical dynamic routes', () => {
        const trie = new Trie();
        trie.define('/d/:id');
        assert.throws(() => trie.define('/d/:name'), 'Should throw on conflicting param name');
    });

    test('should prioritize static over wildcard', () => {
        const trie = new Trie();
        trie.define('/e/static');
        trie.define('/e/:all*');
        const m = trie.match('/e/static');
        assert.ok(m.node, 'Match should not be null');
        assert.strictEqual(m.node.wildcard, false, 'Should match the static node');
    });
});

describe('Advanced `remove` Edge Cases', () => {
    test('should do nothing when removing a non-existent route', () => {
        const trie = new Trie();
        trie.define('/f/g');
        assert.doesNotThrow(() => trie.remove('/f/h'), 'Removing non-existent route should not throw');
        assert.ok(trie.match('/f/g').node, 'Existing route should remain');
    });

    test('should correctly prune parent nodes after removal', () => {
        const trie = new Trie();
        trie.define('/h/i/j');
        assert.ok(trie._findNode('/h/i'), 'Parent node should exist before removal');
        trie.remove('/h/i/j');
        assert.strictEqual(trie._findNode('/h/i/j'), null, 'Node should be gone');
        assert.strictEqual(trie._findNode('/h/i'), null, 'Parent node should be pruned');
        assert.strictEqual(trie._findNode('/h'), null, 'Grandparent node should be pruned');
    });

    test('should handle removing the root path', () => {
        const trie = new Trie();
        trie.define('/');
        trie.define('/about');
        assert.ok(trie.match('/').node, 'Root should match before removal');
        trie.remove('/');
        assert.strictEqual(trie.match('/').node, null, 'Root should not match after removal');
        assert.ok(trie.match('/about').node, 'Other routes should remain intact');
    });
});

describe('Deeply Nested Routes', () => {
    test('should handle very deep static routes', () => {
        const trie = new Trie();
        const deepPath = '/level1/level2/level3/level4/level5/endpoint';
        trie.define(deepPath);
        const m = trie.match(deepPath);
        assert.ok(m.node, 'Should match deep static path');
        assert.strictEqual(m.node.pattern, deepPath);
    });

    test('should handle very deep dynamic routes', () => {
        const trie = new Trie();
        const deepPath = '/org/:org/team/:team/user/:user/project/:proj/file/:file';
        trie.define(deepPath);
        const m = trie.match('/org/acme/team/dev/user/merc/project/router/file/index.js');
        assert.ok(m.node, 'Should match deep dynamic path');
        assert.deepStrictEqual(m.params, {
            org: 'acme',
            team: 'dev',
            user: 'merc',
            proj: 'router',
            file: 'index.js'
        });
    });
});
