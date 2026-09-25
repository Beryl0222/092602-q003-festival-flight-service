/** 进程内基础仓库，后续可替换为持久实现。 */
export class Repository {
  #records = new Map();
  add(record) {
    if (this.#records.has(record.record_id)) throw new Error("记录编号已存在");
    this.#records.set(record.record_id, record);
    return record;
  }
  get(recordId) { return this.#records.get(recordId) ?? null; }
}
