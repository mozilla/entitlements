# shared-locks

`RedisLockStore` is a Redis-backed `LockStore` for `@nestjs/locks`. Provide an ioredis client under `RedisLockStoreClient`, then add `RedisLockStore` to the app's providers alongside `LocksModule.forRoot()`. The store registers itself with `LocksStorage`.

Each lock key `k` uses two Redis keys: `lock:k` for the holder and `fence:k` for the fencing counter, which never expires. The fencing counter must not go backwards, so if anything consumes fencing tokens, Redis needs persistence. Both keys go through the client's `keyPrefix`.

Run `nx test-integration shared-locks` against Redis from `./dev.sh infra` to check the store against the `@nestjs/locks` contract suite.
