var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { injectable, singleton } from 'tsyringe';
import { container as tsy } from 'tsyringe';
let TsyRep1 = class TsyRep1 {
};
TsyRep1 = __decorate([
    injectable()
], TsyRep1);
let TsyRep2 = class TsyRep2 {
};
TsyRep2 = __decorate([
    injectable()
], TsyRep2);
let TsyRep3 = class TsyRep3 {
};
TsyRep3 = __decorate([
    injectable()
], TsyRep3);
let TsySvc1 = class TsySvc1 {
    repo1;
    repo2;
    repo3;
    constructor(repo1, repo2, repo3) {
        this.repo1 = repo1;
        this.repo2 = repo2;
        this.repo3 = repo3;
    }
};
TsySvc1 = __decorate([
    injectable(),
    __metadata("design:paramtypes", [TsyRep1,
        TsyRep2,
        TsyRep3])
], TsySvc1);
let TsySvc2 = class TsySvc2 {
};
TsySvc2 = __decorate([
    injectable()
], TsySvc2);
let TsySvc3 = class TsySvc3 {
};
TsySvc3 = __decorate([
    injectable()
], TsySvc3);
let TsySvc4 = class TsySvc4 {
};
TsySvc4 = __decorate([
    injectable()
], TsySvc4);
let TsySvc5 = class TsySvc5 {
};
TsySvc5 = __decorate([
    injectable()
], TsySvc5);
let TsySvc6 = class TsySvc6 {
};
TsySvc6 = __decorate([
    injectable()
], TsySvc6);
let TsyRoot = class TsyRoot {
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
TsyRoot = __decorate([
    injectable(),
    __metadata("design:paramtypes", [TsySvc1,
        TsySvc2,
        TsySvc3,
        TsySvc4,
        TsySvc5,
        TsySvc6])
], TsyRoot);
export { TsyRoot };
let TsySingletonRoot = class TsySingletonRoot {
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
TsySingletonRoot = __decorate([
    singleton(),
    __metadata("design:paramtypes", [TsySvc1,
        TsySvc2,
        TsySvc3,
        TsySvc4,
        TsySvc5,
        TsySvc6])
], TsySingletonRoot);
export { TsySingletonRoot };
export { tsy };
