/** Positive activation invalidations for Settings → Version. The restoration guard still checks snapshot history. */
import Database from "better-sqlite3";
import {join} from "node:path";
import {readRequestContextBootState} from "./request-context-boot.js";
import {readRequestContextActivations} from "./request-context-activation.js";
export function requestContextGoBackUnavailable(home:string,attemptId:string):boolean {
 if(!readRequestContextBootState(home))return false;
 const db=new Database(join(home,"delivery-outbox.db"),{readonly:true,fileMustExist:true});
 try{return readRequestContextActivations(db).some(row=>row.invalidates.includes(attemptId));}finally{db.close();}
}
