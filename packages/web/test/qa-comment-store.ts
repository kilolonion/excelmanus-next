export const useWorkbookStore=(select:(value:{doc:{rev:number}})=>unknown)=>select({doc:{rev:1}});
