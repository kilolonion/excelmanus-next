import type { ApiClient, CreateModelProfileBody, CreateProviderConnectionBody } from "@excelmanus/protocol";
/** Test setup still exercises both real HTTP endpoints; no production compatibility path. */
export async function createTestProfile(api: ApiClient, body: Omit<CreateModelProfileBody,"connectionId"> & CreateProviderConnectionBody) {
 const {provider,baseUrl,apiKey,extraHeaders,accountId,...model}=body;
 const {connection}=await api.createProviderConnection({name:body.name,provider,baseUrl,apiKey,extraHeaders,accountId});
 return api.createModelProfile({...model,connectionId:connection.id});
}
