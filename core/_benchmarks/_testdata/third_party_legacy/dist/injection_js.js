var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Injectable } from 'injection-js';
import { ReflectiveInjector } from 'injection-js';
let InjRep1 = class InjRep1 {
};
InjRep1 = __decorate([
    Injectable()
], InjRep1);
let InjRep2 = class InjRep2 {
};
InjRep2 = __decorate([
    Injectable()
], InjRep2);
let InjRep3 = class InjRep3 {
};
InjRep3 = __decorate([
    Injectable()
], InjRep3);
let InjSvc1 = class InjSvc1 {
    rep1;
    rep2;
    rep3;
    constructor(rep1, rep2, rep3) {
        this.rep1 = rep1;
        this.rep2 = rep2;
        this.rep3 = rep3;
    }
};
InjSvc1 = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [InjRep1,
        InjRep2,
        InjRep3])
], InjSvc1);
let InjSvc2 = class InjSvc2 {
};
InjSvc2 = __decorate([
    Injectable()
], InjSvc2);
let InjSvc3 = class InjSvc3 {
};
InjSvc3 = __decorate([
    Injectable()
], InjSvc3);
let InjSvc4 = class InjSvc4 {
};
InjSvc4 = __decorate([
    Injectable()
], InjSvc4);
let InjSvc5 = class InjSvc5 {
};
InjSvc5 = __decorate([
    Injectable()
], InjSvc5);
let InjSvc6 = class InjSvc6 {
};
InjSvc6 = __decorate([
    Injectable()
], InjSvc6);
let InjRoot = class InjRoot {
    svc1;
    svc2;
    svc3;
    svc4;
    svc5;
    svc6;
    constructor(svc1, svc2, svc3, svc4, svc5, svc6) {
        this.svc1 = svc1;
        this.svc2 = svc2;
        this.svc3 = svc3;
        this.svc4 = svc4;
        this.svc5 = svc5;
        this.svc6 = svc6;
    }
};
InjRoot = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [InjSvc1,
        InjSvc2,
        InjSvc3,
        InjSvc4,
        InjSvc5,
        InjSvc6])
], InjRoot);
export { InjRoot };
let InjSingletonRoot = class InjSingletonRoot {
    svc1;
    svc2;
    svc3;
    svc4;
    svc5;
    svc6;
    constructor(svc1, svc2, svc3, svc4, svc5, svc6) {
        this.svc1 = svc1;
        this.svc2 = svc2;
        this.svc3 = svc3;
        this.svc4 = svc4;
        this.svc5 = svc5;
        this.svc6 = svc6;
    }
};
InjSingletonRoot = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [InjSvc1,
        InjSvc2,
        InjSvc3,
        InjSvc4,
        InjSvc5,
        InjSvc6])
], InjSingletonRoot);
export { InjSingletonRoot };
export const injResolvedProviders = ReflectiveInjector.resolve([
    InjRep1,
    InjRep2,
    InjRep3,
    InjSvc1,
    InjSvc2,
    InjSvc3,
    InjSvc4,
    InjSvc5,
    InjSvc6,
    InjRoot,
    InjSingletonRoot,
]);
export const injSingletonInjector = ReflectiveInjector.fromResolvedProviders(injResolvedProviders);
