const { db } = require("../config/firebase");

// Generic repository: every write is validated against its Joi schema first.
class Repository {
  constructor(collectionName, schema) {
    this.collectionName = collectionName;
    this.schema = schema;
  }

  col() {
    return db().collection(this.collectionName);
  }

  validate(data) {
    const { error, value } = this.schema.validate(data, {
      stripUnknown: true,
      abortEarly: false,
    });
    if (error) {
      const e = new Error("Validation failed: " + error.details.map((d) => d.message).join("; "));
      e.statusCode = 422;
      throw e;
    }
    return value;
  }

  async create(id, data) {
    const clean = this.validate(data);
    if (id) {
      await this.col().doc(id).set(clean);
      return { id, ...clean };
    }
    const ref = await this.col().add(clean);
    return { id: ref.id, ...clean };
  }

  async update(id, partial) {
    // partial update: validate merged doc to keep contract intact
    const current = await this.findById(id);
    if (!current) {
      const e = new Error(`${this.collectionName}/${id} not found`);
      e.statusCode = 404;
      throw e;
    }
    const merged = this.validate({ ...current, ...partial });
    await this.col().doc(id).set(merged, { merge: true });
    return { id, ...merged };
  }

  async findById(id) {
    const snap = await this.col().doc(id).get();
    return snap.exists ? { id: snap.id, ...snap.data() } : null;
  }

  async delete(id) {
    await this.col().doc(id).delete();
    return { id, deleted: true };
  }

  // cursor pagination
  async paginate({ where = [], orderBy = null, limit = 20, startAfter = null } = {}) {
    let q = this.col();
    where.forEach(([f, op, v]) => (q = q.where(f, op, v)));
    if (orderBy) q = q.orderBy(orderBy.field, orderBy.dir || "asc");
    if (startAfter) q = q.startAfter(startAfter);
    q = q.limit(limit);
    const snap = await q.get();
    const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const last = snap.docs[snap.docs.length - 1] || null;
    return { items, cursor: last ? last.id : null, hasMore: snap.size === limit };
  }
}

module.exports = Repository;
