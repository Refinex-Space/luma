/**
 * Catalogue of Redis commands for the console's highlighting and completion: name
 * (container commands as `CONFIG GET`), argument synopsis as in the Redis docs, summary,
 * group, first version and the argument positions holding keys.
 */

export type RedisGroup =
  | "string"
  | "generic"
  | "hash"
  | "list"
  | "set"
  | "sorted-set"
  | "stream"
  | "pubsub"
  | "scripting"
  | "transactions"
  | "connection"
  | "server"
  | "cluster"
  | "json"
  | "geo"
  | "hyperloglog"
  | "bitmap";

/**
 * Where keys are, as argv indexes (the command name is 0):
 * - `[first, last, step]` like `COMMAND INFO` (`last` -1: to the end, -2: all but the last);
 * - `{ numkeys: i }`: argv[i] counts the keys right after it (`EVAL script numkeys key…`);
 * - `{ after: "STREAMS", half: true }`: the words after a keyword (the first half of them).
 */
export type KeySpec =
  | readonly [first: number, last: number, step: number]
  | { numkeys: number }
  | { after: string; half?: boolean };

export interface RedisCommandDoc {
  /** Upper case; container commands with their subcommand (`CONFIG GET`). */
  name: string;
  /** Argument synopsis (`key field value [field value ...]`). */
  args: string;
  summary: string;
  group: RedisGroup;
  /** First Redis (or module) version with the command. */
  since: string;
  keys?: readonly KeySpec[];
  /** Holds the connection listening (`SUBSCRIBE`, `MONITOR`): the console refuses it. */
  listens?: boolean;
}

type Row = readonly [name: string, args: string, summary: string, since: string, keys?: readonly KeySpec[]];

const K1: readonly KeySpec[] = [[1, 1, 1]];
const K2: readonly KeySpec[] = [[2, 2, 1]];
const K12: readonly KeySpec[] = [[1, 2, 1]];
const KALL: readonly KeySpec[] = [[1, -1, 1]];
const KPAIRS: readonly KeySpec[] = [[1, -1, 2]];
const KBUTLAST: readonly KeySpec[] = [[1, -2, 1]];
const NK1: readonly KeySpec[] = [{ numkeys: 1 }];
const NK2: readonly KeySpec[] = [{ numkeys: 2 }];
const DEST_NK2: readonly KeySpec[] = [[1, 1, 1], { numkeys: 2 }];
const EXPIRY = "[EX seconds | PX milliseconds | EXAT unix-time-seconds | PXAT unix-time-milliseconds";
const FIELDS = "FIELDS numfields field [field ...]";
const COND = "[NX | XX | GT | LT]";
const UNIT = "M | KM | FT | MI";

const GROUPS: Record<RedisGroup, readonly Row[]> = {
  string: [
    [
      "APPEND",
      "key value",
      "Appends a string to the value of a key. Creates the key if it doesn't exist.",
      "2.0.0",
      K1,
    ],
    ["DECR", "key", "Decrements the integer value of a key by one.", "1.0.0", K1],
    ["DECRBY", "key decrement", "Decrements a number from the integer value of a key.", "1.0.0", K1],
    ["GET", "key", "Returns the string value of a key.", "1.0.0", K1],
    ["GETDEL", "key", "Returns the string value of a key after deleting the key.", "6.2.0", K1],
    [
      "GETEX",
      `key ${EXPIRY} | PERSIST]`,
      "Returns the string value of a key after setting its expiration time.",
      "6.2.0",
      K1,
    ],
    ["GETRANGE", "key start end", "Returns a substring of the string stored at a key.", "2.4.0", K1],
    ["GETSET", "key value", "Returns the previous string value of a key after setting it to a new value.", "1.0.0", K1],
    ["INCR", "key", "Increments the integer value of a key by one.", "1.0.0", K1],
    ["INCRBY", "key increment", "Increments the integer value of a key by a number.", "1.0.0", K1],
    ["INCRBYFLOAT", "key increment", "Increments the floating point value of a key by a number.", "2.6.0", K1],
    [
      "LCS",
      "key1 key2 [LEN] [IDX] [MINMATCHLEN min-match-len] [WITHMATCHLEN]",
      "Finds the longest common substring.",
      "7.0.0",
      K12,
    ],
    ["MGET", "key [key ...]", "Atomically returns the string values of one or more keys.", "1.0.0", KALL],
    [
      "MSET",
      "key value [key value ...]",
      "Atomically creates or modifies the string values of one or more keys.",
      "1.0.1",
      KPAIRS,
    ],
    [
      "MSETNX",
      "key value [key value ...]",
      "Atomically sets the values of keys only when none of them exist.",
      "1.0.1",
      KPAIRS,
    ],
    ["PSETEX", "key milliseconds value", "Sets the value and expiration in milliseconds of a key.", "2.6.0", K1],
    [
      "SET",
      `key value [NX | XX] [GET] ${EXPIRY} | KEEPTTL]`,
      "Sets the string value of a key, ignoring its type. The key is created if it doesn't exist.",
      "1.0.0",
      K1,
    ],
    ["SETEX", "key seconds value", "Sets the string value and expiration time of a key.", "2.0.0", K1],
    ["SETNX", "key value", "Sets the string value of a key only when the key doesn't exist.", "1.0.0", K1],
    ["SETRANGE", "key offset value", "Overwrites a part of a string value with another by an offset.", "2.2.0", K1],
    ["STRLEN", "key", "Returns the length of a string value.", "2.2.0", K1],
    ["SUBSTR", "key start end", "Returns a substring from a string value.", "1.0.0", K1],
  ],
  generic: [
    [
      "COPY",
      "source destination [DB destination-db] [REPLACE]",
      "Copies the value of a key to a new key.",
      "6.2.0",
      K12,
    ],
    ["DEL", "key [key ...]", "Deletes one or more keys.", "1.0.0", KALL],
    ["DUMP", "key", "Returns a serialized representation of the value stored at a key.", "2.6.0", K1],
    ["EXISTS", "key [key ...]", "Determines whether one or more keys exist.", "1.0.0", KALL],
    ["EXPIRE", `key seconds ${COND}`, "Sets the expiration time of a key in seconds.", "1.0.0", K1],
    [
      "EXPIREAT",
      `key unix-time-seconds ${COND}`,
      "Sets the expiration time of a key to a Unix timestamp.",
      "1.2.0",
      K1,
    ],
    ["EXPIRETIME", "key", "Returns the expiration time of a key as a Unix timestamp.", "7.0.0", K1],
    ["KEYS", "pattern", "Returns all key names that match a pattern. Blocks the server on large databases.", "1.0.0"],
    [
      "MIGRATE",
      'host port key | "" destination-db timeout [COPY] [REPLACE] [AUTH password | AUTH2 username password] [KEYS key [key ...]]',
      "Atomically transfers a key from one Redis instance to another.",
      "2.6.0",
      [[3, 3, 1], { after: "KEYS" }],
    ],
    ["MOVE", "key db", "Moves a key to another database.", "1.0.0", K1],
    ["OBJECT ENCODING", "key", "Returns the internal encoding of a Redis object.", "2.2.3", K2],
    ["OBJECT FREQ", "key", "Returns the logarithmic access frequency counter of a Redis object.", "4.0.0", K2],
    ["OBJECT IDLETIME", "key", "Returns the time since the last access to a Redis object.", "2.2.3", K2],
    ["OBJECT REFCOUNT", "key", "Returns the reference count of a value of a key.", "2.2.3", K2],
    ["OBJECT HELP", "", "Returns helpful text about the different subcommands.", "6.2.0"],
    ["PERSIST", "key", "Removes the expiration time of a key.", "2.2.0", K1],
    ["PEXPIRE", `key milliseconds ${COND}`, "Sets the expiration time of a key in milliseconds.", "2.6.0", K1],
    [
      "PEXPIREAT",
      `key unix-time-milliseconds ${COND}`,
      "Sets the expiration time of a key to a Unix milliseconds timestamp.",
      "2.6.0",
      K1,
    ],
    ["PEXPIRETIME", "key", "Returns the expiration time of a key as a Unix milliseconds timestamp.", "7.0.0", K1],
    ["PTTL", "key", "Returns the expiration time in milliseconds of a key.", "2.6.0", K1],
    ["RANDOMKEY", "", "Returns a random key name from the database.", "1.0.0"],
    ["RENAME", "key newkey", "Renames a key and overwrites the destination.", "1.0.0", K12],
    ["RENAMENX", "key newkey", "Renames a key only when the target key name doesn't exist.", "1.0.0", K12],
    [
      "RESTORE",
      "key ttl serialized-value [REPLACE] [ABSTTL] [IDLETIME seconds] [FREQ frequency]",
      "Creates a key from the serialized representation of a value.",
      "2.6.0",
      K1,
    ],
    [
      "SCAN",
      "cursor [MATCH pattern] [COUNT count] [TYPE type]",
      "Iterates over the key names in the database.",
      "2.8.0",
    ],
    [
      "SORT",
      "key [BY pattern] [LIMIT offset count] [GET pattern [GET pattern ...]] [ASC | DESC] [ALPHA] [STORE destination]",
      "Sorts the elements in a list, a set, or a sorted set, optionally storing the result.",
      "1.0.0",
      K1,
    ],
    [
      "SORT_RO",
      "key [BY pattern] [LIMIT offset count] [GET pattern [GET pattern ...]] [ASC | DESC] [ALPHA]",
      "Returns the sorted elements of a list, a set, or a sorted set.",
      "7.0.0",
      K1,
    ],
    [
      "TOUCH",
      "key [key ...]",
      "Returns the number of existing keys out of those specified after updating the time they were last accessed.",
      "3.2.1",
      KALL,
    ],
    ["TTL", "key", "Returns the expiration time in seconds of a key.", "1.0.0", K1],
    ["TYPE", "key", "Determines the type of value stored at a key.", "1.0.0", K1],
    ["UNLINK", "key [key ...]", "Asynchronously deletes one or more keys.", "4.0.0", KALL],
    [
      "WAIT",
      "numreplicas timeout",
      "Blocks until the asynchronous replication of all preceding write commands is acknowledged.",
      "3.0.0",
    ],
    [
      "WAITAOF",
      "numlocal numreplicas timeout",
      "Blocks until all preceding write commands are written to the append-only file.",
      "7.2.0",
    ],
  ],
  hash: [
    ["HDEL", "key field [field ...]", "Deletes one or more fields and their values from a hash.", "2.0.0", K1],
    ["HEXISTS", "key field", "Determines whether a field exists in a hash.", "2.0.0", K1],
    ["HEXPIRE", `key seconds ${COND} ${FIELDS}`, "Sets the expiration time of hash fields in seconds.", "7.4.0", K1],
    [
      "HEXPIREAT",
      `key unix-time-seconds ${COND} ${FIELDS}`,
      "Sets the expiration time of hash fields to a Unix timestamp.",
      "7.4.0",
      K1,
    ],
    ["HEXPIRETIME", `key ${FIELDS}`, "Returns the expiration time of hash fields as a Unix timestamp.", "7.4.0", K1],
    ["HGET", "key field", "Returns the value of a field in a hash.", "2.0.0", K1],
    ["HGETALL", "key", "Returns all fields and values in a hash.", "2.0.0", K1],
    ["HGETDEL", `key ${FIELDS}`, "Returns the values of fields and deletes them from a hash.", "8.0.0", K1],
    [
      "HGETEX",
      `key ${EXPIRY} | PERSIST] ${FIELDS}`,
      "Returns the values of fields and sets their expiration time.",
      "8.0.0",
      K1,
    ],
    ["HINCRBY", "key field increment", "Increments the integer value of a field in a hash by a number.", "2.0.0", K1],
    ["HINCRBYFLOAT", "key field increment", "Increments the floating point value of a field by a number.", "2.6.0", K1],
    ["HKEYS", "key", "Returns all fields in a hash.", "2.0.0", K1],
    ["HLEN", "key", "Returns the number of fields in a hash.", "2.0.0", K1],
    ["HMGET", "key field [field ...]", "Returns the values of all fields in a hash.", "2.0.0", K1],
    ["HMSET", "key field value [field value ...]", "Sets the values of multiple fields.", "2.0.0", K1],
    ["HPERSIST", `key ${FIELDS}`, "Removes the expiration time of hash fields.", "7.4.0", K1],
    [
      "HPEXPIRE",
      `key milliseconds ${COND} ${FIELDS}`,
      "Sets the expiration time of hash fields in milliseconds.",
      "7.4.0",
      K1,
    ],
    [
      "HPEXPIREAT",
      `key unix-time-milliseconds ${COND} ${FIELDS}`,
      "Sets the expiration time of hash fields to a Unix milliseconds timestamp.",
      "7.4.0",
      K1,
    ],
    [
      "HPEXPIRETIME",
      `key ${FIELDS}`,
      "Returns the expiration time of hash fields as a Unix milliseconds timestamp.",
      "7.4.0",
      K1,
    ],
    ["HPTTL", `key ${FIELDS}`, "Returns the time to live in milliseconds of hash fields.", "7.4.0", K1],
    ["HRANDFIELD", "key [count [WITHVALUES]]", "Returns one or more random fields from a hash.", "6.2.0", K1],
    [
      "HSCAN",
      "key cursor [MATCH pattern] [COUNT count] [NOVALUES]",
      "Iterates over fields and values of a hash.",
      "2.8.0",
      K1,
    ],
    ["HSET", "key field value [field value ...]", "Creates or modifies the value of a field in a hash.", "2.0.0", K1],
    [
      "HSETEX",
      `key [FNX | FXX] ${EXPIRY} | KEEPTTL] FIELDS numfields field value [field value ...]`,
      "Sets the values of fields and optionally their expiration time.",
      "8.0.0",
      K1,
    ],
    [
      "HSETNX",
      "key field value",
      "Sets the value of a field in a hash only when the field doesn't exist.",
      "2.0.0",
      K1,
    ],
    ["HSTRLEN", "key field", "Returns the length of the value of a field.", "3.2.0", K1],
    ["HTTL", `key ${FIELDS}`, "Returns the time to live in seconds of hash fields.", "7.4.0", K1],
    ["HVALS", "key", "Returns all values in a hash.", "2.0.0", K1],
  ],
  list: [
    [
      "BLMOVE",
      "source destination LEFT | RIGHT LEFT | RIGHT timeout",
      "Pops an element from a list, pushes it to another list and returns it. Blocks until an element is available.",
      "6.2.0",
      K12,
    ],
    [
      "BLMPOP",
      "timeout numkeys key [key ...] LEFT | RIGHT [COUNT count]",
      "Pops the first element from one of multiple lists. Blocks until an element is available.",
      "7.0.0",
      NK2,
    ],
    [
      "BLPOP",
      "key [key ...] timeout",
      "Removes and returns the first element in a list. Blocks until an element is available.",
      "2.0.0",
      KBUTLAST,
    ],
    [
      "BRPOP",
      "key [key ...] timeout",
      "Removes and returns the last element in a list. Blocks until an element is available.",
      "2.0.0",
      KBUTLAST,
    ],
    [
      "BRPOPLPUSH",
      "source destination timeout",
      "Pops an element from a list, pushes it to another list and returns it. Blocks until an element is available.",
      "2.2.0",
      K12,
    ],
    ["LINDEX", "key index", "Returns an element from a list by its index.", "1.0.0", K1],
    [
      "LINSERT",
      "key BEFORE | AFTER pivot element",
      "Inserts an element before or after another element in a list.",
      "2.2.0",
      K1,
    ],
    ["LLEN", "key", "Returns the length of a list.", "1.0.0", K1],
    [
      "LMOVE",
      "source destination LEFT | RIGHT LEFT | RIGHT",
      "Returns an element after popping it from one list and pushing it to another.",
      "6.2.0",
      K12,
    ],
    [
      "LMPOP",
      "numkeys key [key ...] LEFT | RIGHT [COUNT count]",
      "Returns multiple elements from a list after removing them.",
      "7.0.0",
      NK1,
    ],
    ["LPOP", "key [count]", "Returns the first elements in a list after removing them.", "1.0.0", K1],
    [
      "LPOS",
      "key element [RANK rank] [COUNT num-matches] [MAXLEN len]",
      "Returns the index of matching elements in a list.",
      "6.0.6",
      K1,
    ],
    [
      "LPUSH",
      "key element [element ...]",
      "Prepends one or more elements to a list. Creates the key if it doesn't exist.",
      "1.0.0",
      K1,
    ],
    [
      "LPUSHX",
      "key element [element ...]",
      "Prepends one or more elements to a list only when the list exists.",
      "2.2.0",
      K1,
    ],
    ["LRANGE", "key start stop", "Returns a range of elements from a list.", "1.0.0", K1],
    ["LREM", "key count element", "Removes elements from a list.", "1.0.0", K1],
    ["LSET", "key index element", "Sets the value of an element in a list by its index.", "1.0.0", K1],
    ["LTRIM", "key start stop", "Removes elements from both ends of a list.", "1.0.0", K1],
    ["RPOP", "key [count]", "Returns and removes the last elements of a list.", "1.0.0", K1],
    [
      "RPOPLPUSH",
      "source destination",
      "Returns the last element of a list after removing and pushing it to another list.",
      "1.2.0",
      K12,
    ],
    [
      "RPUSH",
      "key element [element ...]",
      "Appends one or more elements to a list. Creates the key if it doesn't exist.",
      "1.0.0",
      K1,
    ],
    ["RPUSHX", "key element [element ...]", "Appends an element to a list only when the list exists.", "2.2.0", K1],
  ],
  set: [
    [
      "SADD",
      "key member [member ...]",
      "Adds one or more members to a set. Creates the key if it doesn't exist.",
      "1.0.0",
      K1,
    ],
    ["SCARD", "key", "Returns the number of members in a set.", "1.0.0", K1],
    ["SDIFF", "key [key ...]", "Returns the difference of multiple sets.", "1.0.0", KALL],
    ["SDIFFSTORE", "destination key [key ...]", "Stores the difference of multiple sets in a key.", "1.0.0", KALL],
    ["SINTER", "key [key ...]", "Returns the intersect of multiple sets.", "1.0.0", KALL],
    [
      "SINTERCARD",
      "numkeys key [key ...] [LIMIT limit]",
      "Returns the number of members of the intersect of multiple sets.",
      "7.0.0",
      NK1,
    ],
    ["SINTERSTORE", "destination key [key ...]", "Stores the intersect of multiple sets in a key.", "1.0.0", KALL],
    ["SISMEMBER", "key member", "Determines whether a member belongs to a set.", "1.0.0", K1],
    ["SMEMBERS", "key", "Returns all members of a set.", "1.0.0", K1],
    ["SMISMEMBER", "key member [member ...]", "Determines whether multiple members belong to a set.", "6.2.0", K1],
    ["SMOVE", "source destination member", "Moves a member from one set to another.", "1.0.0", K12],
    ["SPOP", "key [count]", "Returns one or more random members from a set after removing them.", "1.0.0", K1],
    ["SRANDMEMBER", "key [count]", "Gets one or multiple random members from a set.", "1.0.0", K1],
    ["SREM", "key member [member ...]", "Removes one or more members from a set.", "1.0.0", K1],
    ["SSCAN", "key cursor [MATCH pattern] [COUNT count]", "Iterates over members of a set.", "2.8.0", K1],
    ["SUNION", "key [key ...]", "Returns the union of multiple sets.", "1.0.0", KALL],
    ["SUNIONSTORE", "destination key [key ...]", "Stores the union of multiple sets in a key.", "1.0.0", KALL],
  ],
  "sorted-set": [
    [
      "BZMPOP",
      "timeout numkeys key [key ...] MIN | MAX [COUNT count]",
      "Removes and returns a member by score from one or more sorted sets. Blocks until a member is available.",
      "7.0.0",
      NK2,
    ],
    [
      "BZPOPMAX",
      "key [key ...] timeout",
      "Removes and returns the member with the highest score from one or more sorted sets. Blocks until a member is available.",
      "5.0.0",
      KBUTLAST,
    ],
    [
      "BZPOPMIN",
      "key [key ...] timeout",
      "Removes and returns the member with the lowest score from one or more sorted sets. Blocks until a member is available.",
      "5.0.0",
      KBUTLAST,
    ],
    [
      "ZADD",
      "key [NX | XX] [GT | LT] [CH] [INCR] score member [score member ...]",
      "Adds one or more members to a sorted set, or updates their scores. Creates the key if it doesn't exist.",
      "1.2.0",
      K1,
    ],
    ["ZCARD", "key", "Returns the number of members in a sorted set.", "1.2.0", K1],
    [
      "ZCOUNT",
      "key min max",
      "Returns the count of members in a sorted set that have scores within a range.",
      "2.0.0",
      K1,
    ],
    [
      "ZDIFF",
      "numkeys key [key ...] [WITHSCORES]",
      "Returns the difference between multiple sorted sets.",
      "6.2.0",
      NK1,
    ],
    [
      "ZDIFFSTORE",
      "destination numkeys key [key ...]",
      "Stores the difference of multiple sorted sets in a key.",
      "6.2.0",
      DEST_NK2,
    ],
    ["ZINCRBY", "key increment member", "Increments the score of a member in a sorted set.", "1.2.0", K1],
    [
      "ZINTER",
      "numkeys key [key ...] [WEIGHTS weight [weight ...]] [AGGREGATE SUM | MIN | MAX] [WITHSCORES]",
      "Returns the intersect of multiple sorted sets.",
      "6.2.0",
      NK1,
    ],
    [
      "ZINTERCARD",
      "numkeys key [key ...] [LIMIT limit]",
      "Returns the number of members of the intersect of multiple sorted sets.",
      "7.0.0",
      NK1,
    ],
    [
      "ZINTERSTORE",
      "destination numkeys key [key ...] [WEIGHTS weight [weight ...]] [AGGREGATE SUM | MIN | MAX]",
      "Stores the intersect of multiple sorted sets in a key.",
      "2.0.0",
      DEST_NK2,
    ],
    [
      "ZLEXCOUNT",
      "key min max",
      "Returns the number of members in a sorted set within a lexicographical range.",
      "2.8.9",
      K1,
    ],
    [
      "ZMPOP",
      "numkeys key [key ...] MIN | MAX [COUNT count]",
      "Returns the highest- or lowest-scoring members from one or more sorted sets after removing them.",
      "7.0.0",
      NK1,
    ],
    ["ZMSCORE", "key member [member ...]", "Returns the score of one or more members in a sorted set.", "6.2.0", K1],
    [
      "ZPOPMAX",
      "key [count]",
      "Returns the highest-scoring members from a sorted set after removing them.",
      "5.0.0",
      K1,
    ],
    [
      "ZPOPMIN",
      "key [count]",
      "Returns the lowest-scoring members from a sorted set after removing them.",
      "5.0.0",
      K1,
    ],
    ["ZRANDMEMBER", "key [count [WITHSCORES]]", "Returns one or more random members from a sorted set.", "6.2.0", K1],
    [
      "ZRANGE",
      "key start stop [BYSCORE | BYLEX] [REV] [LIMIT offset count] [WITHSCORES]",
      "Returns members in a sorted set within a range of indexes, scores or lexicographical order.",
      "1.2.0",
      K1,
    ],
    [
      "ZRANGEBYLEX",
      "key min max [LIMIT offset count]",
      "Returns members in a sorted set within a lexicographical range.",
      "2.8.9",
      K1,
    ],
    [
      "ZRANGEBYSCORE",
      "key min max [WITHSCORES] [LIMIT offset count]",
      "Returns members in a sorted set within a range of scores.",
      "1.0.5",
      K1,
    ],
    [
      "ZRANGESTORE",
      "dst src min max [BYSCORE | BYLEX] [REV] [LIMIT offset count]",
      "Stores a range of members from a sorted set in a key.",
      "6.2.0",
      K12,
    ],
    [
      "ZRANK",
      "key member [WITHSCORE]",
      "Returns the index of a member in a sorted set ordered by ascending scores.",
      "2.0.0",
      K1,
    ],
    ["ZREM", "key member [member ...]", "Removes one or more members from a sorted set.", "1.2.0", K1],
    ["ZREMRANGEBYLEX", "key min max", "Removes members in a sorted set within a lexicographical range.", "2.8.9", K1],
    ["ZREMRANGEBYRANK", "key start stop", "Removes members in a sorted set within a range of indexes.", "2.0.0", K1],
    ["ZREMRANGEBYSCORE", "key min max", "Removes members in a sorted set within a range of scores.", "1.2.0", K1],
    [
      "ZREVRANGE",
      "key start stop [WITHSCORES]",
      "Returns members in a sorted set within a range of indexes, in reverse order.",
      "1.2.0",
      K1,
    ],
    [
      "ZREVRANGEBYLEX",
      "key max min [LIMIT offset count]",
      "Returns members in a sorted set within a lexicographical range, in reverse order.",
      "2.8.9",
      K1,
    ],
    [
      "ZREVRANGEBYSCORE",
      "key max min [WITHSCORES] [LIMIT offset count]",
      "Returns members in a sorted set within a range of scores, in reverse order.",
      "2.2.0",
      K1,
    ],
    [
      "ZREVRANK",
      "key member [WITHSCORE]",
      "Returns the index of a member in a sorted set ordered by descending scores.",
      "2.0.0",
      K1,
    ],
    [
      "ZSCAN",
      "key cursor [MATCH pattern] [COUNT count]",
      "Iterates over members and scores of a sorted set.",
      "2.8.0",
      K1,
    ],
    ["ZSCORE", "key member", "Returns the score of a member in a sorted set.", "1.2.0", K1],
    [
      "ZUNION",
      "numkeys key [key ...] [WEIGHTS weight [weight ...]] [AGGREGATE SUM | MIN | MAX] [WITHSCORES]",
      "Returns the union of multiple sorted sets.",
      "6.2.0",
      NK1,
    ],
    [
      "ZUNIONSTORE",
      "destination numkeys key [key ...] [WEIGHTS weight [weight ...]] [AGGREGATE SUM | MIN | MAX]",
      "Stores the union of multiple sorted sets in a key.",
      "2.0.0",
      DEST_NK2,
    ],
  ],
  stream: [
    [
      "XACK",
      "key group id [id ...]",
      "Returns the number of messages that were successfully acknowledged by the consumer group member of a stream.",
      "5.0.0",
      K1,
    ],
    [
      "XADD",
      "key [NOMKSTREAM] [MAXLEN | MINID [= | ~] threshold [LIMIT count]] * | id field value [field value ...]",
      "Appends a new message to a stream. Creates the key if it doesn't exist.",
      "5.0.0",
      K1,
    ],
    [
      "XAUTOCLAIM",
      "key group consumer min-idle-time start [COUNT count] [JUSTID]",
      "Changes, or acquires, ownership of messages in a consumer group, as if the messages were delivered to a consumer group member.",
      "6.2.0",
      K1,
    ],
    [
      "XCLAIM",
      "key group consumer min-idle-time id [id ...] [IDLE ms] [TIME unix-time-milliseconds] [RETRYCOUNT count] [FORCE] [JUSTID] [LASTID lastid]",
      "Changes, or acquires, ownership of a message in a consumer group, as if the message was delivered to a consumer group member.",
      "5.0.0",
      K1,
    ],
    ["XDEL", "key id [id ...]", "Returns the number of messages after removing them from a stream.", "5.0.0", K1],
    [
      "XGROUP CREATE",
      "key group id | $ [MKSTREAM] [ENTRIESREAD entries-read]",
      "Creates a consumer group.",
      "5.0.0",
      K2,
    ],
    ["XGROUP CREATECONSUMER", "key group consumer", "Creates a consumer in a consumer group.", "6.2.0", K2],
    ["XGROUP DELCONSUMER", "key group consumer", "Deletes a consumer from a consumer group.", "5.0.0", K2],
    ["XGROUP DESTROY", "key group", "Destroys a consumer group.", "5.0.0", K2],
    [
      "XGROUP SETID",
      "key group id | $ [ENTRIESREAD entries-read]",
      "Sets the last-delivered ID of a consumer group.",
      "5.0.0",
      K2,
    ],
    ["XINFO CONSUMERS", "key group", "Returns a list of the consumers in a consumer group.", "5.0.0", K2],
    ["XINFO GROUPS", "key", "Returns a list of the consumer groups of a stream.", "5.0.0", K2],
    ["XINFO STREAM", "key [FULL [COUNT count]]", "Returns information about a stream.", "5.0.0", K2],
    ["XLEN", "key", "Return the number of messages in a stream.", "5.0.0", K1],
    [
      "XPENDING",
      "key group [[IDLE min-idle-time] start end count [consumer]]",
      "Returns the information and entries from a stream consumer group's pending entries list.",
      "5.0.0",
      K1,
    ],
    ["XRANGE", "key start end [COUNT count]", "Returns the messages from a stream within a range of IDs.", "5.0.0", K1],
    [
      "XREAD",
      "[COUNT count] [BLOCK milliseconds] STREAMS key [key ...] id [id ...]",
      "Returns messages from multiple streams with IDs greater than the ones requested.",
      "5.0.0",
      [{ after: "STREAMS", half: true }],
    ],
    [
      "XREADGROUP",
      "GROUP group consumer [COUNT count] [BLOCK milliseconds] [NOACK] STREAMS key [key ...] id [id ...]",
      "Returns new or historical messages from a stream for a consumer in a group.",
      "5.0.0",
      [{ after: "STREAMS", half: true }],
    ],
    [
      "XREVRANGE",
      "key end start [COUNT count]",
      "Returns the messages from a stream within a range of IDs in reverse order.",
      "5.0.0",
      K1,
    ],
    [
      "XSETID",
      "key last-id [ENTRIESADDED entries-added] [MAXDELETEDID max-deleted-id]",
      "An internal command for replicating stream values.",
      "5.0.0",
      K1,
    ],
    [
      "XTRIM",
      "key MAXLEN | MINID [= | ~] threshold [LIMIT count]",
      "Deletes messages from the beginning of a stream.",
      "5.0.0",
      K1,
    ],
  ],
  pubsub: [
    [
      "PSUBSCRIBE",
      "pattern [pattern ...]",
      "Listens for messages published to channels that match one or more patterns.",
      "2.0.0",
    ],
    ["PUBLISH", "channel message", "Posts a message to a channel.", "2.0.0"],
    ["PUBSUB CHANNELS", "[pattern]", "Returns the active channels.", "2.8.0"],
    ["PUBSUB NUMPAT", "", "Returns a count of unique pattern subscriptions.", "2.8.0"],
    ["PUBSUB NUMSUB", "[channel [channel ...]]", "Returns a count of subscribers to channels.", "2.8.0"],
    ["PUBSUB SHARDCHANNELS", "[pattern]", "Returns the active shard channels.", "7.0.0"],
    [
      "PUBSUB SHARDNUMSUB",
      "[shardchannel [shardchannel ...]]",
      "Returns the count of subscribers of shard channels.",
      "7.0.0",
    ],
    [
      "PUNSUBSCRIBE",
      "[pattern [pattern ...]]",
      "Stops listening to messages published to channels that match one or more patterns.",
      "2.0.0",
    ],
    ["SPUBLISH", "shardchannel message", "Post a message to a shard channel.", "7.0.0"],
    ["SSUBSCRIBE", "shardchannel [shardchannel ...]", "Listens for messages published to shard channels.", "7.0.0"],
    ["SUBSCRIBE", "channel [channel ...]", "Listens for messages published to channels.", "2.0.0"],
    [
      "SUNSUBSCRIBE",
      "[shardchannel [shardchannel ...]]",
      "Stops listening to messages posted to shard channels.",
      "7.0.0",
    ],
    ["UNSUBSCRIBE", "[channel [channel ...]]", "Stops listening to messages posted to channels.", "2.0.0"],
  ],
  scripting: [
    ["EVAL", "script numkeys [key [key ...]] [arg [arg ...]]", "Executes a server-side Lua script.", "2.6.0", NK2],
    [
      "EVAL_RO",
      "script numkeys [key [key ...]] [arg [arg ...]]",
      "Executes a read-only server-side Lua script.",
      "7.0.0",
      NK2,
    ],
    [
      "EVALSHA",
      "sha1 numkeys [key [key ...]] [arg [arg ...]]",
      "Executes a server-side Lua script by SHA1 digest.",
      "2.6.0",
      NK2,
    ],
    [
      "EVALSHA_RO",
      "sha1 numkeys [key [key ...]] [arg [arg ...]]",
      "Executes a read-only server-side Lua script by SHA1 digest.",
      "7.0.0",
      NK2,
    ],
    ["FCALL", "function numkeys [key [key ...]] [arg [arg ...]]", "Invokes a function.", "7.0.0", NK2],
    ["FCALL_RO", "function numkeys [key [key ...]] [arg [arg ...]]", "Invokes a read-only function.", "7.0.0", NK2],
    ["FUNCTION DELETE", "library-name", "Deletes a library and its functions.", "7.0.0"],
    ["FUNCTION DUMP", "", "Dumps all libraries into a serialized binary payload.", "7.0.0"],
    ["FUNCTION FLUSH", "[ASYNC | SYNC]", "Deletes all libraries and functions.", "7.0.0"],
    ["FUNCTION KILL", "", "Terminates a function during execution.", "7.0.0"],
    [
      "FUNCTION LIST",
      "[LIBRARYNAME library-name-pattern] [WITHCODE]",
      "Returns information about all libraries.",
      "7.0.0",
    ],
    ["FUNCTION LOAD", "[REPLACE] function-code", "Creates a library.", "7.0.0"],
    [
      "FUNCTION RESTORE",
      "serialized-value [FLUSH | APPEND | REPLACE]",
      "Restores all libraries from a payload.",
      "7.0.0",
    ],
    ["FUNCTION STATS", "", "Returns information about a function during execution.", "7.0.0"],
    [
      "SCRIPT EXISTS",
      "sha1 [sha1 ...]",
      "Determines whether server-side Lua scripts exist in the script cache.",
      "2.6.0",
    ],
    ["SCRIPT FLUSH", "[ASYNC | SYNC]", "Removes all server-side Lua scripts from the script cache.", "2.6.0"],
    ["SCRIPT KILL", "", "Terminates a server-side Lua script during execution.", "2.6.0"],
    ["SCRIPT LOAD", "script", "Loads a server-side Lua script to the script cache.", "2.6.0"],
  ],
  transactions: [
    ["DISCARD", "", "Discards a transaction.", "2.0.0"],
    ["EXEC", "", "Executes all commands in a transaction.", "1.2.0"],
    ["MULTI", "", "Starts a transaction.", "1.2.0"],
    ["UNWATCH", "", "Forgets about watched keys of a transaction.", "2.2.0"],
    ["WATCH", "key [key ...]", "Monitors changes to keys to determine the execution of a transaction.", "2.2.0", KALL],
  ],
  connection: [
    ["AUTH", "[username] password", "Authenticates the connection.", "1.0.0"],
    ["CLIENT GETNAME", "", "Returns the name of the connection.", "2.6.9"],
    [
      "CLIENT GETREDIR",
      "",
      "Returns the client ID to which the connection's tracking notifications are redirected.",
      "6.0.0",
    ],
    ["CLIENT ID", "", "Returns the unique client ID of the connection.", "5.0.0"],
    ["CLIENT INFO", "", "Returns information about the connection.", "6.2.0"],
    [
      "CLIENT KILL",
      "[ID client-id] [TYPE NORMAL | MASTER | SLAVE | REPLICA | PUBSUB] [USER username] [ADDR ip:port] [LADDR ip:port] [SKIPME YES | NO] [MAXAGE maxage]",
      "Terminates open connections.",
      "2.4.0",
    ],
    [
      "CLIENT LIST",
      "[TYPE NORMAL | MASTER | REPLICA | PUBSUB] [ID client-id [client-id ...]]",
      "Lists open connections.",
      "2.4.0",
    ],
    ["CLIENT NO-EVICT", "ON | OFF", "Sets the client eviction mode of the connection.", "7.0.0"],
    [
      "CLIENT NO-TOUCH",
      "ON | OFF",
      "Controls whether commands sent by the client affect the LRU/LFU of accessed keys.",
      "7.2.0",
    ],
    ["CLIENT PAUSE", "timeout [WRITE | ALL]", "Suspends commands processing.", "3.0.0"],
    [
      "CLIENT SETINFO",
      "LIB-NAME libname | LIB-VER libver",
      "Sets information specific to the client or connection.",
      "7.2.0",
    ],
    ["CLIENT SETNAME", "connection-name", "Sets the connection name.", "2.6.9"],
    [
      "CLIENT TRACKINGINFO",
      "",
      "Returns information about server-assisted client-side caching for the connection.",
      "6.2.0",
    ],
    [
      "CLIENT UNBLOCK",
      "client-id [TIMEOUT | ERROR]",
      "Unblocks a client blocked by a blocking command from a different connection.",
      "5.0.0",
    ],
    ["CLIENT UNPAUSE", "", "Resumes processing commands from paused clients.", "6.2.0"],
    ["ECHO", "message", "Returns the given string.", "1.0.0"],
    ["HELLO", "[protover [AUTH username password] [SETNAME clientname]]", "Handshakes with the Redis server.", "6.0.0"],
    ["PING", "[message]", "Returns the server's liveliness response.", "1.0.0"],
    ["QUIT", "", "Closes the connection.", "1.0.0"],
    ["RESET", "", "Resets the connection.", "6.2.0"],
    ["SELECT", "index", "Changes the selected database.", "1.0.0"],
  ],
  server: [
    ["ACL CAT", "[category]", "Lists the ACL categories, or the commands inside a category.", "6.0.0"],
    ["ACL DELUSER", "username [username ...]", "Deletes ACL users, and terminates their connections.", "6.0.0"],
    [
      "ACL DRYRUN",
      "username command [arg [arg ...]]",
      "Simulates the execution of a command by a user, without executing the command.",
      "7.0.0",
    ],
    [
      "ACL GENPASS",
      "[bits]",
      "Generates a pseudorandom, secure password that can be used to identify ACL users.",
      "6.0.0",
    ],
    ["ACL GETUSER", "username", "Lists the ACL rules of a user.", "6.0.0"],
    ["ACL LIST", "", "Dumps the effective rules in ACL file format.", "6.0.0"],
    ["ACL LOAD", "", "Reloads the rules from the configured ACL file.", "6.0.0"],
    ["ACL LOG", "[count | RESET]", "Lists recent security events generated due to ACL rejections.", "6.0.0"],
    ["ACL SAVE", "", "Saves the effective ACL rules in the configured ACL file.", "6.0.0"],
    ["ACL SETUSER", "username [rule [rule ...]]", "Creates and modifies an ACL user and its rules.", "6.0.0"],
    ["ACL USERS", "", "Lists all ACL users.", "6.0.0"],
    ["ACL WHOAMI", "", "Returns the authenticated username of the current connection.", "6.0.0"],
    ["BGREWRITEAOF", "", "Asynchronously rewrites the append-only file to disk.", "1.0.0"],
    ["BGSAVE", "[SCHEDULE]", "Asynchronously saves the database(s) to disk.", "1.0.0"],
    ["COMMAND", "", "Returns detailed information about all commands.", "2.8.13"],
    ["COMMAND COUNT", "", "Returns a count of commands.", "2.8.13"],
    [
      "COMMAND DOCS",
      "[command-name [command-name ...]]",
      "Returns documentary information about one, multiple or all commands.",
      "7.0.0",
    ],
    ["COMMAND GETKEYS", "command [arg [arg ...]]", "Extracts the key names from an arbitrary command.", "2.8.13"],
    [
      "COMMAND INFO",
      "[command-name [command-name ...]]",
      "Returns information about one, multiple or all commands.",
      "2.8.13",
    ],
    [
      "COMMAND LIST",
      "[FILTERBY MODULE module-name | ACLCAT category | PATTERN pattern]",
      "Returns a list of command names.",
      "7.0.0",
    ],
    ["CONFIG GET", "parameter [parameter ...]", "Returns the effective values of configuration parameters.", "2.0.0"],
    ["CONFIG RESETSTAT", "", "Resets the server's statistics.", "2.0.0"],
    ["CONFIG REWRITE", "", "Persists the effective configuration to file.", "2.8.0"],
    ["CONFIG SET", "parameter value [parameter value ...]", "Sets configuration parameters in-flight.", "2.0.0"],
    ["DBSIZE", "", "Returns the number of keys in the database.", "1.0.0"],
    ["FLUSHALL", "[ASYNC | SYNC]", "Removes all keys from all databases.", "1.0.0"],
    ["FLUSHDB", "[ASYNC | SYNC]", "Removes all keys from the current database.", "1.0.0"],
    ["INFO", "[section [section ...]]", "Returns information and statistics about the server.", "1.0.0"],
    ["LASTSAVE", "", "Returns the Unix timestamp of the last successful save to disk.", "1.0.0"],
    ["LATENCY DOCTOR", "", "Returns a human-readable latency analysis report.", "2.8.13"],
    ["LATENCY GRAPH", "event", "Returns a latency graph for an event.", "2.8.13"],
    [
      "LATENCY HISTOGRAM",
      "[command [command ...]]",
      "Returns the cumulative distribution of latencies of a subset or all commands.",
      "7.0.0",
    ],
    ["LATENCY HISTORY", "event", "Returns timestamp-latency samples for an event.", "2.8.13"],
    ["LATENCY LATEST", "", "Returns the latest latency samples for all events.", "2.8.13"],
    ["LATENCY RESET", "[event [event ...]]", "Resets the latency data for one or more events.", "2.8.13"],
    ["LOLWUT", "[VERSION version]", "Displays computer art and the Redis version.", "5.0.0"],
    ["MEMORY DOCTOR", "", "Outputs a memory problems report.", "4.0.0"],
    ["MEMORY MALLOC-STATS", "", "Returns the allocator statistics.", "4.0.0"],
    ["MEMORY PURGE", "", "Asks the allocator to release memory.", "4.0.0"],
    ["MEMORY STATS", "", "Returns details about memory usage.", "4.0.0"],
    ["MEMORY USAGE", "key [SAMPLES count]", "Estimates the memory usage of a key.", "4.0.0", K2],
    ["MODULE LIST", "", "Returns all loaded modules.", "4.0.0"],
    ["MODULE LOAD", "path [arg [arg ...]]", "Loads a module.", "4.0.0"],
    ["MODULE UNLOAD", "name", "Unloads a module.", "4.0.0"],
    ["MONITOR", "", "Listens for all requests received by the server in real-time.", "1.0.0"],
    [
      "REPLICAOF",
      "host port | NO ONE",
      "Configures a server as replica of another, or promotes it to a master.",
      "5.0.0",
    ],
    ["ROLE", "", "Returns the replication role.", "2.8.12"],
    ["SAVE", "", "Synchronously saves the database(s) to disk.", "1.0.0"],
    [
      "SHUTDOWN",
      "[NOSAVE | SAVE] [NOW] [FORCE] [ABORT]",
      "Synchronously saves the database(s) to disk and shuts down the Redis server.",
      "1.0.0",
    ],
    ["SLOWLOG GET", "[count]", "Returns the slow log's entries.", "2.2.12"],
    ["SLOWLOG LEN", "", "Returns the number of entries in the slow log.", "2.2.12"],
    ["SLOWLOG RESET", "", "Clears all entries from the slow log.", "2.2.12"],
    ["SWAPDB", "index1 index2", "Swaps two Redis databases.", "4.0.0"],
    ["TIME", "", "Returns the server time.", "2.6.0"],
  ],
  cluster: [
    ["CLUSTER COUNTKEYSINSLOT", "slot", "Returns the number of keys in a hash slot.", "3.0.0"],
    ["CLUSTER GETKEYSINSLOT", "slot count", "Returns the key names in a hash slot.", "3.0.0"],
    ["CLUSTER INFO", "", "Returns information about the state of a node.", "3.0.0"],
    ["CLUSTER KEYSLOT", "key", "Returns the hash slot for a key.", "3.0.0"],
    ["CLUSTER MYID", "", "Returns the ID of a node.", "3.0.0"],
    ["CLUSTER NODES", "", "Returns the cluster configuration for a node.", "3.0.0"],
    ["CLUSTER SHARDS", "", "Returns the mapping of cluster slots to shards.", "7.0.0"],
    ["CLUSTER SLOTS", "", "Returns the mapping of cluster slots to nodes.", "3.0.0"],
    ["READONLY", "", "Enables read-only queries for a connection to a Redis Cluster replica node.", "3.0.0"],
    ["READWRITE", "", "Enables read-write queries for a connection to a Redis Cluster replica node.", "3.0.0"],
  ],
  json: [
    [
      "JSON.ARRAPPEND",
      "key [path] value [value ...]",
      "Appends one or more JSON values into the array at path after the last element in it.",
      "1.0.0",
      K1,
    ],
    [
      "JSON.ARRINDEX",
      "key path value [start [stop]]",
      "Returns the index of the first occurrence of a JSON scalar value in the array at path.",
      "1.0.0",
      K1,
    ],
    [
      "JSON.ARRINSERT",
      "key path index value [value ...]",
      "Inserts the JSON scalar(s) value at the specified index in the array at path.",
      "1.0.0",
      K1,
    ],
    ["JSON.ARRLEN", "key [path]", "Returns the length of the array at path.", "1.0.0", K1],
    [
      "JSON.ARRPOP",
      "key [path [index]]",
      "Removes and returns the element at the specified index in the array at path.",
      "1.0.0",
      K1,
    ],
    [
      "JSON.ARRTRIM",
      "key path start stop",
      "Trims the array at path to contain only the specified inclusive range of indices from start to stop.",
      "1.0.0",
      K1,
    ],
    [
      "JSON.CLEAR",
      "key [path]",
      "Clears all values from an array or an object and sets numeric values to 0.",
      "2.0.0",
      K1,
    ],
    ["JSON.DEBUG MEMORY", "key [path]", "Reports the size in bytes of a key.", "1.0.0", K2],
    ["JSON.DEL", "key [path]", "Deletes a value.", "1.0.0", K1],
    ["JSON.FORGET", "key [path]", "Deletes a value.", "1.0.0", K1],
    [
      "JSON.GET",
      "key [INDENT indent] [NEWLINE newline] [SPACE space] [path [path ...]]",
      "Gets the value at one or more paths in JSON serialized form.",
      "1.0.0",
      K1,
    ],
    ["JSON.MERGE", "key path value", "Merges a given JSON value into matching paths.", "2.6.0", K1],
    ["JSON.MGET", "key [key ...] path", "Returns the values at a path from one or more keys.", "1.0.0", KBUTLAST],
    [
      "JSON.MSET",
      "key path value [key path value ...]",
      "Sets or updates the JSON value of one or more keys.",
      "2.6.0",
      [[1, -1, 3]],
    ],
    ["JSON.NUMINCRBY", "key path value", "Increments the numeric value at path by a value.", "1.0.0", K1],
    ["JSON.NUMMULTBY", "key path value", "Multiplies the numeric value at path by a value.", "1.0.0", K1],
    ["JSON.OBJKEYS", "key [path]", "Returns the JSON keys of the object at path.", "1.0.0", K1],
    ["JSON.OBJLEN", "key [path]", "Returns the number of keys of the object at path.", "1.0.0", K1],
    ["JSON.RESP", "key [path]", "Returns the JSON value at path in Redis Serialization Protocol (RESP).", "1.0.0", K1],
    ["JSON.SET", "key path value [NX | XX]", "Sets or updates the JSON value at a path.", "1.0.0", K1],
    ["JSON.STRAPPEND", "key [path] value", "Appends a string to a JSON string value at path.", "1.0.0", K1],
    ["JSON.STRLEN", "key [path]", "Returns the length of the JSON String at path in key.", "1.0.0", K1],
    ["JSON.TOGGLE", "key path", "Toggles a boolean value.", "2.0.0", K1],
    ["JSON.TYPE", "key [path]", "Returns the type of the JSON value at path.", "1.0.0", K1],
  ],
  geo: [
    [
      "GEOADD",
      "key [NX | XX] [CH] longitude latitude member [longitude latitude member ...]",
      "Adds one or more members to a geospatial index. The key is created if it doesn't exist.",
      "3.2.0",
      K1,
    ],
    [
      "GEODIST",
      `key member1 member2 [${UNIT}]`,
      "Returns the distance between two members of a geospatial index.",
      "3.2.0",
      K1,
    ],
    [
      "GEOHASH",
      "key [member [member ...]]",
      "Returns members from a geospatial index as geohash strings.",
      "3.2.0",
      K1,
    ],
    [
      "GEOPOS",
      "key [member [member ...]]",
      "Returns the longitude and latitude of members from a geospatial index.",
      "3.2.0",
      K1,
    ],
    [
      "GEORADIUS",
      `key longitude latitude radius ${UNIT} [WITHCOORD] [WITHDIST] [WITHHASH] [COUNT count [ANY]] [ASC | DESC] [STORE key | STOREDIST key]`,
      "Queries a geospatial index for members within a distance from a coordinate, optionally stores the result.",
      "3.2.0",
      K1,
    ],
    [
      "GEORADIUSBYMEMBER",
      `key member radius ${UNIT} [WITHCOORD] [WITHDIST] [WITHHASH] [COUNT count [ANY]] [ASC | DESC] [STORE key | STOREDIST key]`,
      "Queries a geospatial index for members within a distance from a member, optionally stores the result.",
      "3.2.0",
      K1,
    ],
    [
      "GEOSEARCH",
      `key FROMMEMBER member | FROMLONLAT longitude latitude BYRADIUS radius ${UNIT} | BYBOX width height ${UNIT} [ASC | DESC] [COUNT count [ANY]] [WITHCOORD] [WITHDIST] [WITHHASH]`,
      "Queries a geospatial index for members inside an area of a box or a circle.",
      "6.2.0",
      K1,
    ],
    [
      "GEOSEARCHSTORE",
      `destination source FROMMEMBER member | FROMLONLAT longitude latitude BYRADIUS radius ${UNIT} | BYBOX width height ${UNIT} [ASC | DESC] [COUNT count [ANY]] [STOREDIST]`,
      "Queries a geospatial index for members inside an area of a box or a circle, optionally stores the result.",
      "6.2.0",
      K12,
    ],
  ],
  hyperloglog: [
    [
      "PFADD",
      "key [element [element ...]]",
      "Adds elements to a HyperLogLog key. Creates the key if it doesn't exist.",
      "2.8.9",
      K1,
    ],
    [
      "PFCOUNT",
      "key [key ...]",
      "Returns the approximated cardinality of the set(s) observed by the HyperLogLog key(s).",
      "2.8.9",
      KALL,
    ],
    [
      "PFMERGE",
      "destkey [sourcekey [sourcekey ...]]",
      "Merges one or more HyperLogLog values into a single key.",
      "2.8.9",
      KALL,
    ],
  ],
  bitmap: [
    [
      "BITCOUNT",
      "key [start end [BYTE | BIT]]",
      "Counts the number of set bits (population counting) in a string.",
      "2.6.0",
      K1,
    ],
    [
      "BITFIELD",
      "key [GET encoding offset | [OVERFLOW WRAP | SAT | FAIL] SET encoding offset value | INCRBY encoding offset increment ...]",
      "Performs arbitrary bitfield integer operations on strings.",
      "3.2.0",
      K1,
    ],
    [
      "BITFIELD_RO",
      "key [GET encoding offset [GET encoding offset ...]]",
      "Performs arbitrary read-only bitfield integer operations on strings.",
      "6.0.0",
      K1,
    ],
    [
      "BITOP",
      "AND | OR | XOR | NOT destkey key [key ...]",
      "Performs bitwise operations on multiple strings, and stores the result.",
      "2.6.0",
      [[2, -1, 1]],
    ],
    [
      "BITPOS",
      "key bit [start [end [BYTE | BIT]]]",
      "Finds the first set (1) or clear (0) bit in a string.",
      "2.8.7",
      K1,
    ],
    ["GETBIT", "key offset", "Returns a bit value by offset.", "2.2.0", K1],
    [
      "SETBIT",
      "key offset value",
      "Sets or clears the bit at offset of the string value. Creates the key if it doesn't exist.",
      "2.2.0",
      K1,
    ],
  ],
};

const LISTENING = new Set(["SUBSCRIBE", "PSUBSCRIBE", "SSUBSCRIBE", "MONITOR"]);

export const REDIS_COMMANDS: readonly RedisCommandDoc[] = (
  Object.entries(GROUPS) as Array<[RedisGroup, readonly Row[]]>
)
  .flatMap(([group, rows]) =>
    rows.map(([name, args, summary, since, keys]): RedisCommandDoc => ({
      name,
      args,
      summary,
      group,
      since,
      ...(keys ? { keys } : {}),
      ...(LISTENING.has(name) ? { listens: true } : {}),
    })),
  )
  .sort((a, b) => a.name.localeCompare(b.name));

const BY_NAME = new Map(REDIS_COMMANDS.map((c) => [c.name, c]));

/** Container commands (`CONFIG`, `CLIENT`, `XINFO`…) → their subcommands. */
const SUBCOMMANDS = new Map<string, RedisCommandDoc[]>();
for (const c of REDIS_COMMANDS) {
  const space = c.name.indexOf(" ");
  if (space < 0) continue;
  const head = c.name.slice(0, space);
  SUBCOMMANDS.set(head, [...(SUBCOMMANDS.get(head) ?? []), c]);
}

export function commandDoc(name: string): RedisCommandDoc | undefined {
  return BY_NAME.get(name.toUpperCase());
}

export function isContainer(name: string): boolean {
  return SUBCOMMANDS.has(name.toUpperCase());
}

export function subcommandsOf(container: string): readonly RedisCommandDoc[] {
  return SUBCOMMANDS.get(container.toUpperCase()) ?? [];
}

/** Whether `name` is a command or a container of commands (highlighting). */
export function isCommandName(name: string): boolean {
  const n = name.toUpperCase();
  return BY_NAME.has(n) || SUBCOMMANDS.has(n);
}

/** The command a line's words run: `CONFIG GET …` before `CONFIG`; null when unknown. */
export function findCommand(words: readonly string[]): RedisCommandDoc | null {
  const [first, second] = words;
  if (!first) return null;
  if (second !== undefined) {
    const sub = BY_NAME.get(`${first.toUpperCase()} ${second.toUpperCase()}`);
    if (sub) return sub;
  }
  return BY_NAME.get(first.toUpperCase()) ?? null;
}

/** Words of a command's name (1, or 2 for a subcommand). */
export const nameWords = (doc: RedisCommandDoc) => doc.name.split(" ").length;

/**
 * Whether argv[`index`] of a line running `doc` is a key, given the words typed so far
 * (`numkeys` and `STREAMS` positions depend on them).
 */
export function isKeyPosition(doc: RedisCommandDoc, words: readonly string[], index: number): boolean {
  for (const spec of doc.keys ?? []) {
    if ("numkeys" in spec) {
      const n = Number(words[spec.numkeys]);
      if (Number.isInteger(n) && index > spec.numkeys && index <= spec.numkeys + n) return true;
    } else if (!("after" in spec)) {
      const [first, last, step] = spec;
      if (index < first) continue;
      // `last` -2 (all but the last word): the last is unknown while typing.
      if (last >= 0 && index > last) continue;
      if ((index - first) % step === 0) return true;
    } else {
      const at = words.findIndex((w, i) => i > 0 && i < index && w.toUpperCase() === spec.after);
      if (at < 0 || index <= at) continue;
      if (!spec.half) return true;
      // `STREAMS key [key ...] id [id ...]`: keys until the first word reading as an id.
      const before = words.slice(at + 1, index);
      if (!before.some(isStreamId)) return true;
    }
  }
  return false;
}

const isStreamId = (w: string) => /^(\$|>|\+|-|\d+(-\d+|-\*)?)$/.test(w);

/** Upper-case literal words of a synopsis (`EX`, `NX`, `WITHSCORES`…): the command's options. */
export function optionWords(doc: RedisCommandDoc): readonly string[] {
  let words = OPTIONS.get(doc);
  if (!words) {
    words = [...new Set(doc.args.match(/\b[A-Z][A-Z0-9_-]*[A-Z0-9]\b|\b[A-Z]\b/g) ?? [])];
    OPTIONS.set(doc, words);
  }
  return words;
}

const OPTIONS = new WeakMap<RedisCommandDoc, readonly string[]>();
