// An in-memory S3 client, shared by both services for the same reason the
// Dynamo one is: the Gateway WRITES a kelabo's archive at end
// (`gateway/src/db.js` PutObject) and the REST API READS it back for the record
// detail page (`rest-api/src/records.js` GetObject). Two separate stubs would
// make "end a kelabo, then open its record" pass with an empty transcript —
// which is the assertion most worth having.

class NoSuchKey extends Error {
  constructor(key) {
    super(`no such key: ${key}`);
    this.name = "NoSuchKey";
    this.$metadata = { httpStatusCode: 404 };
  }
}

export function createInMemoryS3() {
  /** `bucket/key` -> string body */
  const objects = new Map();
  const at = (input) => `${input.Bucket}/${input.Key}`;

  const HANDLERS = {
    PutObjectCommand: (input) => {
      const body = typeof input.Body === "string" ? input.Body : Buffer.from(input.Body).toString("utf8");
      objects.set(at(input), body);
      return {};
    },
    GetObjectCommand: (input) => {
      const body = objects.get(at(input));
      if (body === undefined) throw new NoSuchKey(input.Key);
      return {
        Body: {
          transformToString: async () => body,
          // The SDK's Body is also an async iterable; anything reading it that
          // way should get the same bytes rather than undefined.
          async *[Symbol.asyncIterator]() {
            yield Buffer.from(body, "utf8");
          },
        },
      };
    },
    DeleteObjectCommand: (input) => {
      objects.delete(at(input));
      return {};
    },
  };

  return {
    async send(command) {
      const kind = command?.constructor?.name;
      const handler = HANDLERS[kind];
      if (!handler) throw new Error(`in-memory s3: unsupported command ${kind}`);
      return handler(command.input);
    },
    dump() {
      return Object.fromEntries(objects);
    },
  };
}
