import { container as tsy } from 'tsyringe';
declare class TsyRep1 {
}
declare class TsyRep2 {
}
declare class TsyRep3 {
}
declare class TsySvc1 {
    readonly repo1: TsyRep1;
    readonly repo2: TsyRep2;
    readonly repo3: TsyRep3;
    constructor(repo1: TsyRep1, repo2: TsyRep2, repo3: TsyRep3);
}
declare class TsySvc2 {
}
declare class TsySvc3 {
}
declare class TsySvc4 {
}
declare class TsySvc5 {
}
declare class TsySvc6 {
}
export declare class TsyRoot {
    readonly svc1: TsySvc1;
    readonly svc2: TsySvc2;
    readonly svc3: TsySvc3;
    readonly svc4: TsySvc4;
    readonly svc5: TsySvc5;
    readonly svc6: TsySvc6;
    constructor(svc1: TsySvc1, svc2: TsySvc2, svc3: TsySvc3, svc4: TsySvc4, svc5: TsySvc5, svc6: TsySvc6);
}
export declare class TsySingletonRoot {
    readonly svc1: TsySvc1;
    readonly svc2: TsySvc2;
    readonly svc3: TsySvc3;
    readonly svc4: TsySvc4;
    readonly svc5: TsySvc5;
    readonly svc6: TsySvc6;
    constructor(svc1: TsySvc1, svc2: TsySvc2, svc3: TsySvc3, svc4: TsySvc4, svc5: TsySvc5, svc6: TsySvc6);
}
export { tsy };
