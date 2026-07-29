declare class NestRep1 {
}
declare class NestRep2 {
}
declare class NestRep3 {
}
declare class NestSvc1 {
    readonly repo1: NestRep1;
    readonly repo2: NestRep2;
    readonly repo3: NestRep3;
    constructor(repo1: NestRep1, repo2: NestRep2, repo3: NestRep3);
}
declare class NestSvc2 {
}
declare class NestSvc3 {
}
declare class NestSvc4 {
}
declare class NestSvc5 {
}
declare class NestSvc6 {
}
export declare class NestRoot {
    readonly svc1: NestSvc1;
    readonly svc2: NestSvc2;
    readonly svc3: NestSvc3;
    readonly svc4: NestSvc4;
    readonly svc5: NestSvc5;
    readonly svc6: NestSvc6;
    constructor(svc1: NestSvc1, svc2: NestSvc2, svc3: NestSvc3, svc4: NestSvc4, svc5: NestSvc5, svc6: NestSvc6);
}
export declare class NestTransientRoot {
    readonly svc1: NestSvc1;
    readonly svc2: NestSvc2;
    readonly svc3: NestSvc3;
    readonly svc4: NestSvc4;
    readonly svc5: NestSvc5;
    readonly svc6: NestSvc6;
    constructor(svc1: NestSvc1, svc2: NestSvc2, svc3: NestSvc3, svc4: NestSvc4, svc5: NestSvc5, svc6: NestSvc6);
}
export declare class App {
}
export declare function bootstrap(): Promise<import("@nestjs/common").INestApplicationContext>;
export {};
