'use strict';

var assert = require('assert');
var config = require("./lib/config");
var helper = require('./helper');
var redis = config.redis;
var zlib = require('zlib');
var uuid = require('uuid');
var client;

describe("The 'multi' method", function () {

    afterEach(function () {
        client.end(true);
    });

    describe('regression test', function () {
        it('saved buffers with charsets different than utf-8 (issue #913)', function (done) {
            this.timeout(12000); // Windows tests on 0.10 are slow
            client = redis.createClient();

            var end = helper.callFuncAfter(done, 100);

            // Some random object created from http://beta.json-generator.com/
            var test_obj = {
                "_id": "5642c4c33d4667c4a1fefd99","index": 0, "guid": "5baf1f1c-7621-41e7-ae7a-f8c6f3199b0f", "isActive": true,
                "balance": "$1,028.63", "picture": "http://placehold.it/32x32", "age": 31, "eyeColor": "green", "name": {"first": "Shana", "last": "Long"},
                "company": "MANGLO", "email": "shana.long@manglo.us", "phone": "+1 (926) 405-3105", "address": "747 Dank Court, Norfolk, Ohio, 1112",
                "about": "Eu pariatur in nisi occaecat enim qui consequat nostrud cupidatat id. " +
                    "Commodo commodo dolore esse irure minim quis deserunt anim laborum aute deserunt et est. Quis nisi laborum deserunt nisi quis.",
                "registered": "Friday, April 18, 2014 9:56 AM", "latitude": "74.566613", "longitude": "-11.660432", "tags": [7, "excepteur"],
                "range": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], "friends": [3, {"id": 1, "name": "Schultz Dyer"}],
                "greeting": "Hello, Shana! You have 5 unread messages.", "favoriteFruit": "strawberry"
            };

            function run () {
                if (end() === true) {
                    return;
                }
                // To demonstrate a big payload for hash set field values, let's create a big array
                var test_arr = [];
                for (var i = 0; i < 80; i++) {
                    var new_obj = JSON.parse(JSON.stringify(test_obj));
                    test_arr.push(new_obj);
                }

                var json = JSON.stringify(test_arr);
                zlib.deflate(new Buffer(json), function (err, buffer) {
                    if (err) {
                        done(err);
                        return;
                    }

                    var multi = client.multi();
                    multi.del('SOME_KEY');

                    for (i = 0; i < 100; i++) {
                        multi.hset('SOME_KEY', 'SOME_FIELD' + i, buffer);
                    }
                    multi.exec(function (err, res) {
                        if (err) {
                            done(err);
                            return;
                        }
                        run();
                    });
                });
            }
            run();
        });
    });

    describe('pipeline limit', function () {

        it('do not exceed maximum string size', function (done) {
            this.timeout(25000); // Windows tests are horribly slow
            // Triggers a RangeError: Invalid string length if not handled properly
            client = redis.createClient();
            var multi = client.multi();
            var i = Math.pow(2, 28);
            while (i > 0) {
                i -= 10230;
                multi.set('foo' + i, 'bar' + new Array(1024).join('1234567890'));
            }
            client.on('ready', function () {
                multi.exec(function (err, res) {
                    assert.strictEqual(res.length, 26241);
                });
                client.flushdb(done);
            });
        });

    });

    helper.allTests(function(parser, ip, args) {

        describe("using " + parser + " and " + ip, function () {
            var key, value;

            beforeEach(function () {
                key = uuid.v4();
                value = uuid.v4();
            });

            describe("when not connected", function () {

                beforeEach(function (done) {
                    client = redis.createClient.apply(redis.createClient, args);
                    client.once("ready", function () {
                        client.quit();
                    });
                    client.once('end', function () {
                        return done();
                    });
                });

                it("reports an error", function (done) {
                    var multi = client.multi();
                    var notBuffering = multi.exec(function (err, res) {
                        assert(err.message.match(/The connection has already been closed/));
                        done();
                    });
                    assert.strictEqual(notBuffering, false);
                });

                it("reports an error if promisified", function () {
                    return client.multi().execAsync().catch(function(err) {
                        assert(err.message.match(/The connection has already been closed/));
                    });
                });
            });

            describe("when connected", function () {

                beforeEach(function (done) {
                    client = redis.createClient.apply(redis.createClient, args);
                    client.once("connect", done);
                });

                it("executes a pipelined multi properly in combination with the offline queue", function (done) {
                    var multi1 = client.multi();
                    multi1.set("m1", "123");
                    multi1.get('m1');
                    multi1.exec(done);
                });

                it("executes a pipelined multi properly after a reconnect in combination with the offline queue", function (done) {
                    client.once('ready', function () {
                        client.stream.destroy();
                        var called = false;
                        var multi1 = client.multi();
                        multi1.set("m1", "123");
                        multi1.get('m1');
                        multi1.exec(function (err, res) {
                            assert(!err);
                            called = true;
                        });
                        client.once('ready', function () {
                            var multi1 = client.multi();
                            multi1.set("m2", "456");
                            multi1.get('m2');
                            multi1.exec(function (err, res) {
                                assert(called);
                                assert(!err);
                                assert.strictEqual(res[1], '456');
                                done();
                            });
                        });
                    });
                });
            });

            describe("when connection is broken", function () {

                it("return an error even if connection is in broken mode if callback is present", function (done) {
                    client = redis.createClient({
                        host: 'somewhere',
                        port: 6379,
                        max_attempts: 1
                    });

                    client.on('error', function(err) {
                        if (/Redis connection in broken state/.test(err.message)) {
                            done();
                        }
                    });

                    client.multi([['set', 'foo', 'bar'], ['get', 'foo']]).exec(function (err, res) {
                        assert(/Redis connection in broken state/.test(err.message));
                        assert.strictEqual(err.errors.length, 0);
                    });
                });

                it("does not emit an error twice if connection is in broken mode with no callback", function (done) {
                    client = redis.createClient({
                        host: 'somewhere',
                        port: 6379,
                        max_attempts: 1
                    });

                    client.on('error', function(err) {
                        // Results in multiple done calls if test fails
                        if (/Redis connection in broken state/.test(err.message)) {
                            done();
                        }
                    });

                    client.multi([['set', 'foo', 'bar'], ['get', 'foo']]).exec();
                });
            });

            describe("when ready", function () {

                beforeEach(function (done) {
                    client = redis.createClient.apply(redis.createClient, args);
                    client.once("ready", function () {
                        client.flushdb(function (err) {
                            return done(err);
                        });
                    });
                });

                it("returns an empty result array", function (done) {
                    var multi = client.multi();
                    var notBuffering = multi.exec(function (err, res) {
                        assert.strictEqual(err, null);
                        assert.strictEqual(res.length, 0);
                        done();
                    });
                    assert.strictEqual(notBuffering, true);
                });

                it("runs normal calls in-between multis", function (done) {
                    var multi1 = client.multi();
                    multi1.set("m1", "123");
                    client.set('m2', '456', done);
                });

                it("runs simultaneous multis with the same client", function (done) {
                    var end = helper.callFuncAfter(done, 2);

                    var multi1 = client.multi();
                    multi1.set("m1", "123");
                    multi1.get('m1');

                    var multi2 = client.multi();
                    multi2.set("m2", "456");
                    multi2.get('m2');

                    multi1.exec(end);
                    multi2.exec(function(err, res) {
                        assert.strictEqual(res[1], '456');
                        end();
                    });
                });

                it("runs simultaneous multis with the same client version 2", function (done) {
                    var end = helper.callFuncAfter(done, 2);
                    var multi2 = client.multi();
                    var multi1 = client.multi();

                    multi2.set("m2", "456");
                    multi1.set("m1", "123");
                    multi1.get('m1');
                    multi2.get('m2');
                    multi2.ping();

                    multi1.exec(end);
                    multi2.exec(function(err, res) {
                        assert.strictEqual(res[1], '456');
                        end();
                    });
                });

                it('roles back a transaction when one command in a sequence of commands fails', function (done) {
                    var multi1, multi2;
                    // Provoke an error at queue time
                    multi1 = client.MULTI();
                    multi1.mset("multifoo", "10", "multibar", "20", helper.isString("OK"));

                    multi1.set("foo2", helper.isError());
                    multi1.incr("multifoo");
                    multi1.incr("multibar");
                    multi1.exec(function () {
                        // Redis 2.6.5+ will abort transactions with errors
                        // see: http://redis.io/topics/transactions
                        var multibar_expected = 1;
                        var multifoo_expected = 1;
                        // Confirm that the previous command, while containing an error, still worked.
                        multi2 = client.multi();
                        multi2.incr("multibar", helper.isNumber(multibar_expected));
                        multi2.incr("multifoo", helper.isNumber(multifoo_expected));
                        multi2.exec(function (err, replies) {
                            assert.strictEqual(multibar_expected, replies[0]);
                            assert.strictEqual(multifoo_expected, replies[1]);
                            return done();
                        });
                    });
                });

                it('roles back a transaction when one command in an array of commands fails', function (done) {
                    // test nested multi-bulk replies
                    client.multi([
                        ["mget", "multifoo", "multibar", function (err, res) {
                            assert.strictEqual(2, res.length);
                            assert.strictEqual(0, +res[0]);
                            assert.strictEqual(0, +res[1]);
                        }],
                        ["set", "foo2", helper.isError()],
                        ["incr", "multifoo"],
                        ["incr", "multibar"]
                    ]).exec(function (err, replies) {
                        assert.notEqual(err, null);
                        assert.equal(replies, undefined);
                        return done();
                    });
                });

                it('handles multiple operations being applied to a set', function (done) {
                    client.sadd("some set", "mem 1");
                    client.sadd(["some set", "mem 2"]);
                    client.sadd("some set", "mem 3");
                    client.sadd("some set", "mem 4");

                    // make sure empty mb reply works
                    client.del("some missing set");
                    client.smembers("some missing set", function (err, reply) {
                        // make sure empty mb reply works
                        assert.strictEqual(0, reply.length);
                    });

                    // test nested multi-bulk replies with empty mb elements.
                    client.multi([
                        ["smembers", ["some set"]],
                        ["del", "some set"],
                        ["smembers", "some set"]
                    ])
                    .scard("some set")
                    .exec(function (err, replies) {
                        assert.strictEqual(4, replies[0].length);
                        assert.strictEqual(0, replies[2].length);
                        return done();
                    });
                });

                it('allows multiple operations to be performed using constructor with all kinds of syntax', function (done) {
                    var now = Date.now();
                    var arr = ["multihmset", "multibar", "multibaz"];
                    var arr2 = ['some manner of key', 'otherTypes'];
                    var arr3 = [5768, "multibarx", "multifoox"];
                    var arr4 = ["mset", [578, "multibar"], helper.isString('OK')];
                    client.multi([
                        arr4,
                        [["mset", "multifoo2", "multibar2", "multifoo3", "multibar3"], helper.isString('OK')],
                        ["hmset", arr],
                        [["hmset", "multihmset2", "multibar2", "multifoo3", "multibar3", "test"], helper.isString('OK')],
                        ["hmset", ["multihmset", "multibar", "multifoo"], helper.isString('OK')],
                        ["hmset", arr3, helper.isString('OK')],
                        ['hmset', now, {123456789: "abcdefghij", "some manner of key": "a type of value", "otherTypes": 555}],
                        ['hmset', 'key2', {"0123456789": "abcdefghij", "some manner of key": "a type of value", "otherTypes": 999}, helper.isString('OK')],
                        ["HMSET", "multihmset", ["multibar", "multibaz"], undefined], // undefined is used as a explicit not set callback variable
                        ["hmset", "multihmset", ["multibar", "multibaz"], helper.isString('OK')],
                    ])
                    .hmget(now, 123456789, 'otherTypes')
                    .hmget('key2', arr2, function noop() {})
                    .hmget(['multihmset2', 'some manner of key', 'multibar3'])
                    .mget('multifoo2', ['multifoo3', 'multifoo'], function(err, res) {
                        assert(res[0], 'multifoo3');
                        assert(res[1], 'multifoo');
                    })
                    .exec(function (err, replies) {
                        assert.equal(arr.length, 3);
                        assert.equal(arr2.length, 2);
                        assert.equal(arr3.length, 3);
                        assert.equal(arr4.length, 3);
                        assert.strictEqual(null, err);
                        assert.equal(replies[10][1], '555');
                        assert.equal(replies[11][0], 'a type of value');
                        assert.strictEqual(replies[12][0], null);
                        assert.equal(replies[12][1], 'test');
                        assert.equal(replies[13][0], 'multibar2');
                        assert.equal(replies[13].length, 3);
                        assert.equal(replies.length, 14);
                        return done();
                    });
                });

                it('converts a non string key to a string', function(done) {
                    // TODO: Converting the key might change soon again.
                    client.multi().hmset(true, {
                        test: 123,
                        bar: 'baz'
                    }).exec(done);
                });

                it('runs a multi without any further commands', function(done) {
                    var buffering = client.multi().exec(function(err, res) {
                        assert.strictEqual(err, null);
                        assert.strictEqual(res.length, 0);
                        done();
                    });
                    assert(typeof buffering === 'boolean');
                });

                it('allows multiple operations to be performed using a chaining API', function (done) {
                    client.multi()
                        .mset('some', '10', 'keys', '20')
                        .incr('some')
                        .incr('keys')
                        .mget('some', ['keys'])
                        .exec(function (err, replies) {
                            assert.strictEqual(null, err);
                            assert.equal('OK', replies[0]);
                            assert.equal(11, replies[1]);
                            assert.equal(21, replies[2]);
                            assert.equal(11, replies[3][0].toString());
                            assert.equal(21, replies[3][1].toString());
                            return done();
                        });
                });

                it('allows multiple commands to work the same as normal to be performed using a chaining API', function (done) {
                    client.multi()
                        .mset(['some', '10', 'keys', '20'])
                        .incr('some', helper.isNumber(11))
                        .incr(['keys'], helper.isNumber(21))
                        .mget('some', 'keys')
                        .exec(function (err, replies) {
                            assert.strictEqual(null, err);
                            assert.equal('OK', replies[0]);
                            assert.equal(11, replies[1]);
                            assert.equal(21, replies[2]);
                            assert.equal(11, replies[3][0].toString());
                            assert.equal(21, replies[3][1].toString());
                            return done();
                        });
                });

                it('allows multiple commands to work the same as normal to be performed using a chaining API promisified', function () {
                    return client.multi()
                        .mset(['some', '10', 'keys', '20'])
                        .incr('some', helper.isNumber(11))
                        .incr(['keys'], helper.isNumber(21))
                        .mget('some', 'keys')
                        .execAsync()
                        .then(function (replies) {
                            assert.equal('OK', replies[0]);
                            assert.equal(11, replies[1]);
                            assert.equal(21, replies[2]);
                            assert.equal(11, replies[3][0].toString());
                            assert.equal(21, replies[3][1].toString());
                        });
                });

                it('allows an array to be provided indicating multiple operations to perform', function (done) {
                    // test nested multi-bulk replies with nulls.
                    client.multi([
                        ["mget", ["multifoo", "some", "random value", "keys"]],
                        ["incr", "multifoo"]
                    ])
                    .exec(function (err, replies) {
                        assert.strictEqual(replies.length, 2);
                        assert.strictEqual(replies[0].length, 4);
                        return done();
                    });
                });

                it('allows multiple operations to be performed on a hash', function (done) {
                    client.multi()
                        .hmset("multihash", "a", "foo", "b", 1)
                        .hmset("multihash", {
                            extra: "fancy",
                            things: "here"
                        })
                        .hgetall("multihash")
                        .exec(function (err, replies) {
                            assert.strictEqual(null, err);
                            assert.equal("OK", replies[0]);
                            assert.equal(Object.keys(replies[2]).length, 4);
                            assert.equal("foo", replies[2].a);
                            assert.equal("1", replies[2].b);
                            assert.equal("fancy", replies[2].extra);
                            assert.equal("here", replies[2].things);
                            return done();
                        });
                });

                it('reports EXECABORT exceptions when they occur (while queueing)', function (done) {
                    client.multi().config("bar").set("foo").set("bar").exec(function (err, reply) {
                        assert.equal(err.code, "EXECABORT");
                        assert.equal(reply, undefined, "The reply should have been discarded");
                        assert(err.message.match(/^EXECABORT/), "Error message should begin with EXECABORT");
                        assert.equal(err.errors.length, 2, "err.errors should have 2 items");
                        assert.strictEqual(err.errors[0].command, 'SET');
                        assert.strictEqual(err.errors[0].code, 'ERR');
                        assert.strictEqual(err.errors[0].position, 1);
                        assert(/^ERR/.test(err.errors[0].message), "Actuall error message should begin with ERR");
                        return done();
                    });
                });

                it('reports multiple exceptions when they occur (while EXEC is running)', function (done) {
                    client.multi().config("bar").debug("foo").eval("return {err='this is an error'}", 0).exec(function (err, reply) {
                        assert.strictEqual(reply.length, 3);
                        assert.equal(reply[0].code, 'ERR');
                        assert.equal(reply[0].command, 'CONFIG');
                        assert.equal(reply[2].code, undefined);
                        assert.equal(reply[2].command, 'EVAL');
                        assert(/^this is an error/.test(reply[2].message));
                        assert(/^ERR/.test(reply[0].message), "Error message should begin with ERR");
                        assert(/^ERR/.test(reply[1].message), "Error message should begin with ERR");
                        return done();
                    });
                });

                it('reports multiple exceptions when they occur (while EXEC is running) promisified', function () {
                    return client.multi().config("bar").debug("foo").eval("return {err='this is an error'}", 0).execAsync().then(function (reply) {
                        assert.strictEqual(reply.length, 3);
                        assert.equal(reply[0].code, 'ERR');
                        assert.equal(reply[0].command, 'CONFIG');
                        assert.equal(reply[2].code, undefined);
                        assert.equal(reply[2].command, 'EVAL');
                        assert(/^this is an error/.test(reply[2].message));
                        assert(/^ERR/.test(reply[0].message), "Error message should begin with ERR");
                        assert(/^ERR/.test(reply[1].message), "Error message should begin with ERR");
                    });
                });

                it('reports multiple exceptions when they occur (while EXEC is running) and calls cb', function (done) {
                    var multi = client.multi();
                    multi.config("bar", helper.isError());
                    multi.set('foo', 'bar', helper.isString('OK'));
                    multi.debug("foo").exec(function (err, reply) {
                        assert.strictEqual(reply.length, 3);
                        assert.strictEqual(reply[0].code, 'ERR');
                        assert(/^ERR/.test(reply[0].message), "Error message should begin with ERR");
                        assert(/^ERR/.test(reply[2].message), "Error message should begin with ERR");
                        assert.strictEqual(reply[1], "OK");
                        client.get('foo', helper.isString('bar', done));
                    });
                });

                it("emits an error if no callback has been provided and execabort error occured", function (done) {
                    var multi = client.multi();
                    multi.config("bar");
                    multi.set("foo");
                    multi.exec();

                    client.on('error', function(err) {
                        assert.equal(err.code, "EXECABORT");
                        done();
                    });
                });

                it("should work without any callback", function (done) {
                    var multi = client.multi();
                    multi.set("baz", "binary");
                    multi.set("foo", "bar");
                    multi.exec();

                    client.get('foo', helper.isString('bar', done));
                });

                it("should not use a transaction with exec_atomic if no command is used", function () {
                    var multi = client.multi();
                    var test = false;
                    multi.exec_batch = function () {
                        test = true;
                    };
                    multi.exec_atomic();
                    assert(test);
                });

                it("should not use a transaction with exec_atomic if only one command is used", function () {
                    var multi = client.multi();
                    var test = false;
                    multi.exec_batch = function () {
                        test = true;
                    };
                    multi.set("baz", "binary");
                    multi.exec_atomic();
                    assert(test);
                });

                it("should use transaction with exec_atomic and more than one command used", function (done) {
                    var multi = client.multi();
                    var test = false;
                    multi.exec_batch = function () {
                        test = true;
                    };
                    multi.set("baz", "binary");
                    multi.get('baz');
                    multi.exec_atomic(done);
                    assert(!test);
                });

                it("do not mutate arguments in the multi constructor", function (done) {
                    var input = [['set', 'foo', 'bar'], ['get', 'foo']];
                    client.multi(input).exec(function (err, res) {
                        assert.strictEqual(input.length, 2);
                        assert.strictEqual(input[0].length, 3);
                        assert.strictEqual(input[1].length, 2);
                        done();
                    });
                });

                it("works properly after a reconnect. issue #897", function (done) {
                    client.stream.destroy();
                    client.on('error', function (err) {
                        assert.strictEqual(err.code, 'ECONNREFUSED');
                    });
                    client.on('ready', function () {
                        client.multi([['set', 'foo', 'bar'], ['get', 'foo']]).exec(function (err, res) {
                            assert(!err);
                            assert.strictEqual(res[1], 'bar');
                            done();
                        });
                    });
                });

                it("emits error once if reconnecting after multi has been executed but not yet returned without callback", function (done) {
                    client.on('error', function(err) {
                        assert.strictEqual(err.code, 'UNCERTAIN_STATE');
                        done();
                    });

                    client.multi().set("foo", 'bar').get('foo').exec();
                    // Abort connection before the value returned
                    client.stream.destroy();
                });

            });
        });
    });
});
