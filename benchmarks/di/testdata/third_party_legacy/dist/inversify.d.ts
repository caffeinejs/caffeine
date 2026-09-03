declare class InvRep1 {
}
declare class InvRep2 {
}
declare class InvRep3 {
}
declare class InvSvc1 {
    readonly repo1: InvRep1;
    readonly repo2: InvRep2;
    readonly repo3: InvRep3;
    constructor(repo1: InvRep1, repo2: InvRep2, repo3: InvRep3);
}
declare class InvSvc2 {
}
declare class InvSvc3 {
}
declare class InvSvc4 {
}
declare class InvSvc5 {
}
declare class InvSvc6 {
}
export declare class InvRoot {
    readonly svc1: InvSvc1;
    readonly svc2: InvSvc2;
    readonly svc3: InvSvc3;
    readonly svc4: InvSvc4;
    readonly svc5: InvSvc5;
    readonly svc6: InvSvc6;
    constructor(svc1: InvSvc1, svc2: InvSvc2, svc3: InvSvc3, svc4: InvSvc4, svc5: InvSvc5, svc6: InvSvc6);
}
export declare class InvRootSingleton {
    readonly svc1: InvSvc1;
    readonly svc2: InvSvc2;
    readonly svc3: InvSvc3;
    readonly svc4: InvSvc4;
    readonly svc5: InvSvc5;
    readonly svc6: InvSvc6;
    constructor(svc1: InvSvc1, svc2: InvSvc2, svc3: InvSvc3, svc4: InvSvc4, svc5: InvSvc5, svc6: InvSvc6);
}
declare const inv: any;
export { inv };
