import { Context } from '@loopback/context';
declare class LoopRep {
}
declare class LoopSvc {
    readonly repo: LoopRep;
    constructor(repo: LoopRep);
}
export declare class LoopRoot {
    readonly svc: LoopSvc;
    constructor(svc: LoopSvc);
}
export declare class LoopSingletonRoot {
    readonly svc: LoopSvc;
    constructor(svc: LoopSvc);
}
declare const ctx: Context;
export { ctx as loopCtx };
