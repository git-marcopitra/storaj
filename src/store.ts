import { writeFile } from "fs/promises";
import { readFileSync, existsSync, mkdirSync} from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";
import { ItemDefault, Item, Index } from "./types";
import { Query, executeQuery } from "./query";
//TODO: Add doc comments

type SerializedItem<T> = {
    [Property in keyof T]: T[Property];
} & { _id: Index; _collection: string };

export type SerializedDefault = SerializedItem<unknown>;

type PersistFn = () => Promise<void>;

//#TODO: Implement options for the persistance
export class Collection<Schema extends ItemDefault = ItemDefault> {
    name: string;
    private _items: Map<Index, Item<Schema>> = new Map();
    private _onUpdate: PersistFn;

    constructor(name: string, onUpdate: PersistFn) {
        this.name = name;
        this._onUpdate = onUpdate;
    }

    private _validateInsert(item: Item<Schema>) {
        const idIsValid =
            itemHasProp(item, "_id", "string") ||
            itemHasProp(item, "_id", "number");
        if (!idIsValid) {
            throw new Error(
                `InsertionError: The id of an item must be a number or a string.`
            );
        }
        if (this._items.has(item._id)) {
            throw new Error(
                `InsertionError: The id '${item._id}' already exists in the '${this.name}' collection`
            );
        }
    }

    private _putInMap(object: Omit<Schema, "_id">, id?: Index) {
        if (id === undefined) {
            id = randomUUID();
        }
        const item = { _id: id, ...object } as Item<Schema>;
        this._validateInsert(item);
        this._items.set(item._id, item);
    }

    /**Inserts an item into the collection and persists the changes
      @params {CellaItem} item - the item to add to the collection 
    **/
    //#TODO: Return the inserted object or it's id
    async insert(object: Omit<Schema, "_id">, id?: Index) {
        this._putInMap(object, id);
        await this._onUpdate();
    }

    /**Inserts an item into the collection but does not sync 
      the changes with the data on disk**/
    insertSync(object: Omit<Schema, "_id">, id?: Index) {
        this._putInMap(object, id);
    }

    get(id: Index): Item<Schema> | null {
        const item = this._items.get(id);
        if (item === undefined) {
            return null;
        }
        return item;
    }

    query(q: Query<Schema>): Item<Schema>[] {
        return executeQuery(this._items, q);
    }

    aggregate() {}

    //#TODO: Add same type as normal insert;
    _insertNoSave(item: Schema) {
        this._validateInsert(item);
        this._items.set(item._id, item);
        item;
    }

    /** Returns all the items in a collection*/
    all(): Schema[] {
        return Array.from(this._items.values());
    }

    count(): number {
        return this._items.size;
    }
}

export class Store {
    /**@property fPath - Path to the file where the data should be persisted*/
    readonly fPath: string;
    readonly _collections: Map<string | number, Collection> = new Map();

    //#TODO: Implement options for the persistance
    /** Provides references to the collections in the store.
        If the collection does not exist, it will be created
     * @param {string} collection - name of the collection to be returned.
     */
    constructor(fPath: string = "") {
        //Empty string means that data should not be persisted to disk
        this.fPath = fPath;
        this.initStore();
    }

    initStore() {        
        if (!this.fPath) return;

        if (!existsSync(dirname(this.fPath))) return;
        
        const fileData = JSON.parse(readFileSync(this.fPath, "utf8"));

        if (!(fileData instanceof Array)) {
            throw new Error(
                "Invalid schema coming from file. Data must be an array of objects"
            );
        }
        fileData.forEach((item) => {
            validateSerializedItem(item);
            const collection = this.collections(item._collection);
            const { _id, _collection, ...data } = item;
            collection._insertNoSave({ _id, ...data });
        });
    }

    collections<T extends ItemDefault>(collection: string): Collection<T> {
        let ref = this._collections.get(collection);
        if (ref === undefined) {
            ref = new Collection(collection, this.persist);
            this._collections.set(collection, ref);
        }
        return ref as Collection<T>;
    }

    hasCollection(collection: string): boolean {
        return this._collections.has(collection);
    }

    /** Returns the name of all collections in the store.
     */
    collNames(): string[] {
        return Array.from(this._collections.keys()) as string[];
    }

    serialize(): string {
        let items: SerializedItem<SerializedDefault>[] = [];
        for (let collection of this._collections.values()) {
            const serializedItems = collection
                .all()
                .map(({ _id, ...rest }) => ({
                    _id,
                    _collection: collection.name,
                    ...rest,
                }));
            items = [...items, ...serializedItems];
        }
        return JSON.stringify(items);
    }

    async persist() {
        if (!this.fPath) {
            return;
        }
        const folderName =  dirname(this.fPath);
        if (!existsSync(folderName)) {
            mkdirSync(folderName);
        }
        await writeFile(this.fPath, this.serialize(), { encoding: "utf8" });
    }
}

export function itemHasProp<T>(
    item: T,
    prop: keyof T,
    type: "number" | "string" | "object" | "undefined"
): boolean {
    const value = item[prop];
    if (value === undefined) {
        return false;
    }
    const propType = typeof value;
    // Ids can be numbers or strings;
    if (propType !== type) {
        return false;
    }
    return true;
}

export function validateSerializedItem(
    item: SerializedItem<SerializedDefault>
) {
    //Empty string id
    if (item._id === "") {
        throw new Error(
            `InvalidItemError: id must not be empty. item: ${JSON.stringify(
                item
            )}`
        );
    }
    if (item._collection === "") {
        throw new Error(
            `InvalidItemError: collection name must not be empty. item: ${JSON.stringify(
                item
            )}`
        );
    }
    const isValid =
        (itemHasProp(item, "_id", "string") ||
            itemHasProp(item, "_id", "number")) &&
        itemHasProp(item, "_collection", "string");
    if (!isValid) {
        throw new Error(
            `InvalidItemError: The following item is missing props or has props of the wrong type: ${JSON.stringify(
                item
            )}`
        );
    }
}

export function storeFromObjects<T extends SerializedDefault>(
    storedData: SerializedItem<T>[],
    storePath: string = ""
): Store {
    const store = new Store(storePath);
    if (!(storedData instanceof Array)) {
        throw new Error(
            "Invalid schema passed to function. Argument must be an array of objects"
        );
    }
    storedData.forEach((item) => {
        validateSerializedItem(item);
        const collection = store.collections(item._collection);
        const { _id, _collection, ...data } = item;
        collection._insertNoSave({ _id, ...data });
    });
    return store;
}

export function storeFromFile(storePath: string): Store {
    let storedData: SerializedItem<SerializedDefault>[];
    storedData = JSON.parse(readFileSync(storePath, "utf8"));
    return storeFromObjects(storedData, storePath);
}
