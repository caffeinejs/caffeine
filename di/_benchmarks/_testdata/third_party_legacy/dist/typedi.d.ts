import { Container } from 'typedi';
declare class TypeRep1 {
}
declare class TypeRep2 {
}
declare class TypeRep3 {
}
declare class TypeSvc1 {
    readonly repo1: TypeRep1;
    readonly repo2: TypeRep2;
    readonly repo3: TypeRep3;
    constructor(repo1: TypeRep1, repo2: TypeRep2, repo3: TypeRep3);
}
declare class TypeSvc2 {
}
declare class TypeSvc3 {
}
declare class TypeSvc4 {
}
declare class TypeSvc5 {
}
declare class TypeSvc6 {
}
export declare class TypeRoot {
    readonly svc1: TypeSvc1;
    readonly svc2: TypeSvc2;
    readonly svc3: TypeSvc3;
    readonly svc4: TypeSvc4;
    readonly svc5: TypeSvc5;
    readonly svc6: TypeSvc6;
    constructor(svc1: TypeSvc1, svc2: TypeSvc2, svc3: TypeSvc3, svc4: TypeSvc4, svc5: TypeSvc5, svc6: TypeSvc6);
}
export declare class TypeSingletonRoot {
    readonly svc1: TypeSvc1;
    readonly svc2: TypeSvc2;
    readonly svc3: TypeSvc3;
    readonly svc4: TypeSvc4;
    readonly svc5: TypeSvc5;
    readonly svc6: TypeSvc6;
    constructor(svc1: TypeSvc1, svc2: TypeSvc2, svc3: TypeSvc3, svc4: TypeSvc4, svc5: TypeSvc5, svc6: TypeSvc6);
}
export { Container as typeContainer };
