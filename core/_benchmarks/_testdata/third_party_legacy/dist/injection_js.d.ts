import { ReflectiveInjector } from 'injection-js';
import type { ResolvedReflectiveProvider } from 'injection-js';
declare class InjRep1 {
}
declare class InjRep2 {
}
declare class InjRep3 {
}
declare class InjSvc1 {
    readonly rep1: InjRep1;
    readonly rep2: InjRep2;
    readonly rep3: InjRep3;
    constructor(rep1: InjRep1, rep2: InjRep2, rep3: InjRep3);
}
declare class InjSvc2 {
}
declare class InjSvc3 {
}
declare class InjSvc4 {
}
declare class InjSvc5 {
}
declare class InjSvc6 {
}
export declare class InjRoot {
    readonly svc1: InjSvc1;
    readonly svc2: InjSvc2;
    readonly svc3: InjSvc3;
    readonly svc4: InjSvc4;
    readonly svc5: InjSvc5;
    readonly svc6: InjSvc6;
    constructor(svc1: InjSvc1, svc2: InjSvc2, svc3: InjSvc3, svc4: InjSvc4, svc5: InjSvc5, svc6: InjSvc6);
}
export declare class InjSingletonRoot {
    readonly svc1: InjSvc1;
    readonly svc2: InjSvc2;
    readonly svc3: InjSvc3;
    readonly svc4: InjSvc4;
    readonly svc5: InjSvc5;
    readonly svc6: InjSvc6;
    constructor(svc1: InjSvc1, svc2: InjSvc2, svc3: InjSvc3, svc4: InjSvc4, svc5: InjSvc5, svc6: InjSvc6);
}
export declare const injResolvedProviders: ResolvedReflectiveProvider[];
export declare const injSingletonInjector: ReflectiveInjector;
export {};
