import { FirebaseFirestore, QuerySnapshot, QueryDocumentSnapshot } from "@firebase/firestore-types";
import { ResourceManager, IResource } from "./ResourceManager";
import { RAFirebaseOptions } from "index";
import { log, logError } from "../../misc/logger";
import { sortArray, filterArray } from "../../misc/arrayHelpers";
import { IFirebaseWrapper } from "./firebase/IFirebaseWrapper";
import { IFirebaseClient } from "./IFirebaseClient";
import { messageTypes } from '../../misc/messageTypes'
import { resolve } from "dns";

function isAlreadyCached(r: IResource, params: messageTypes.IParamsGetList): boolean {
  if (!r.cachedFrom) {
    return false;
  }
  const cachedFrom = r.cachedFrom;
  const requiredFrom = {
    filter: params.filter,
    sort: params.sort,
    pagination: params.pagination
  }
  const currentCachedFrom = JSON.stringify(cachedFrom);
  const requiredCachedFrom = JSON.stringify(requiredFrom);
  log('checking cache:', {currentCachedFrom, requiredCachedFrom});
  return currentCachedFrom === requiredCachedFrom;
}

export class FirebaseClient implements IFirebaseClient {
  private db: FirebaseFirestore;
  private rm: ResourceManager;

  constructor(
    private fireWrapper: IFirebaseWrapper,
    private options: RAFirebaseOptions
  ) {
    this.db = fireWrapper.db();
    this.rm = new ResourceManager(this.db, this.options);
  }
  public async apiGetList(resourceName: string, params: messageTypes.IParamsGetList): Promise<messageTypes.IResponseGetList> {
    log("apiGetList", { resourceName, params });
    const r = await this.tryGetResource(resourceName);
    let dataPage: {}[];
    if (this.options.serverSide) {
      const alreadyCached = isAlreadyCached(r, params);
      if (alreadyCached) {
        dataPage = r.cached;
      } else {
        if (r.activeSubscription) {
          r.activeSubscription.unsubscribe();
        }
        const collection = r.collection
        const observable = this.rm.getCollectionObservable(collection);
        dataPage = await new Promise((resolve, reject) => {
          const observer = async (querySnapshot: QuerySnapshot) => {
            const newList = querySnapshot.docs.map(
              (doc: QueryDocumentSnapshot) =>
                this.rm.parseFireStoreDocument(doc)
            );
            r.cached = newList;
            // The data has been set, so resolve the promise
            resolve(newList);
          };
          r.activeSubscription = observable.subscribe(observer);
        })
      }
    } else {
      const data = r.cached;
      sortArray(data, params.sort);
      const filteredData = filterArray(data, params.filter);
      const pageStart = (params.pagination.page - 1) * params.pagination.perPage;
      const pageEnd = pageStart + params.pagination.perPage;
      dataPage = filteredData.slice(pageStart, pageEnd);
    }
    const total = dataPage.length;
    return {
      data: dataPage,
      total: total
    };
  }
  public async apiGetOne(resourceName: string, params: messageTypes.IParamsGetOne): Promise<messageTypes.IResponseGetOne> {
    const r = await this.tryGetResource(resourceName);
    log("apiGetOne", { resourceName, resource: r, params });
    const data = r.cached.filter((val: {
      id: string;
    }) => val.id === params.id);
    if (data.length < 1) {
      throw new Error("react-admin-firebase: No id found matching: " + params.id);
    }
    return { data: data.pop() };
  }
  public async apiCreate(resourceName: string, params: messageTypes.IParamsCreate): Promise<messageTypes.IResponseCreate> {
    const r = await this.tryGetResource(resourceName);
    log("apiCreate", { resourceName, resource: r, params });
    const hasOverridenDocId = params.data && params.data.id;
    if (hasOverridenDocId) {
      const newDocId = params.data.id;
      if (!newDocId) {
        throw new Error('id must be a valid string');
      }
      await r.collection.doc(newDocId).set({
        ...params.data,
        createdate: this.fireWrapper.serverTimestamp(),
        lastupdate: this.fireWrapper.serverTimestamp()
      }, { merge: true });
      return {
        data: {
          ...params.data,
          id: newDocId
        }
      };
    }

    const doc = await r.collection.add({
      ...params.data,
      createdate: this.fireWrapper.serverTimestamp(),
      lastupdate: this.fireWrapper.serverTimestamp()
    });
    return {
      data: {
        ...params.data,
        id: doc.id
      }
    };
  }
  public async apiUpdate(resourceName: string, params: messageTypes.IParamsUpdate): Promise<messageTypes.IResponseUpdate> {
    const id = params.id;
    delete params.data.id;
    const r = await this.tryGetResource(resourceName);
    log("apiUpdate", { resourceName, resource: r, params });
    r.collection.doc(id).update({
      ...params.data,
      lastupdate: this.fireWrapper.serverTimestamp()
    }).catch((error) => {
      logError("apiUpdate error", { error });
    });
    return {
      data: {
        ...params.data,
        id: id
      }
    };
  }
  public async apiUpdateMany(resourceName: string, params: messageTypes.IParamsUpdateMany): Promise<messageTypes.IResponseUpdateMany> {
    delete params.data.id;
    const r = await this.tryGetResource(resourceName);
    log("apiUpdateMany", { resourceName, resource: r, params });
    const ids = params.ids;
    const returnData = ids.map((id) => {
      r.collection.doc(id).update({
        ...params.data,
        lastupdate: this.fireWrapper.serverTimestamp()
      }).catch((error) => {
        logError("apiUpdateMany error", { error });
      });
      return {
        ...params.data,
        id: id
      };
    });
    return {
      data: returnData
    };
  }
  public async apiDelete(resourceName: string, params: messageTypes.IParamsDelete): Promise<messageTypes.IResponseDelete> {
    const r = await this.tryGetResource(resourceName);
    log("apiDelete", { resourceName, resource: r, params });
    r.cached = r.cached.filter((doc) => doc["id"] !== params.id);
    r.collection.doc(params.id).delete().catch((error) => {
      logError("apiDelete error", { error });
    });
    return {
      data: params.previousData
    };
  }
  public async apiDeleteMany(resourceName: string, params: messageTypes.IParamsDeleteMany): Promise<messageTypes.IResponseDeleteMany> {
    const r = await this.tryGetResource(resourceName);
    log("apiDeleteMany", { resourceName, resource: r, params });
    const returnData = [];
    const batch = this.db.batch();
    for (const id of params.ids) {
      batch.delete(r.collection.doc(id));
      returnData.push({ id });
    }
    batch.commit().catch((error) => {
      logError("apiDeleteMany error", { error });
    });
    return { data: returnData };
  }
  public async apiGetMany(resourceName: string, params: messageTypes.IParamsGetMany): Promise<messageTypes.IResponseGetMany> {
    const r = await this.tryGetResource(resourceName);
    log("apiGetMany", { resourceName, resource: r, params });
    const ids = new Set(params.ids);
    const matches = r.cached.filter((item) => ids.has(item["id"]));
    return {
      data: matches
    };
  }
  public async apiGetManyReference(
    resourceName: string,
    params: messageTypes.IParamsGetManyReference
  ): Promise<messageTypes.IResponseGetManyReference> {
    const r = await this.tryGetResource(resourceName);
    log("apiGetManyReference", { resourceName, resource: r, params });
    const data = r.cached;
    const targetField = params.target;
    const targetValue = params.id;
    const matches = data.filter((val) => val[targetField] === targetValue);
    sortArray(data, params.sort);
    const pageStart = (params.pagination.page - 1) * params.pagination.perPage;
    const pageEnd = pageStart + params.pagination.perPage;
    const dataPage = matches.slice(pageStart, pageEnd);
    const total = matches.length;
    return { data: dataPage, total };
  }
  public GetResource(resourceName: string): IResource {
    return this.rm.GetResource(resourceName);
  }
  private tryGetResource(resourceName: string, filter?: {}): Promise<IResource> {
    if (filter) {
      return this.rm.TryGetResourcePromise(resourceName);
    } else {
      return this.rm.TryGetResourcePromise(resourceName);
    }
  }
}