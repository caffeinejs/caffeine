var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { injectable } from 'inversify';
import { Container } from 'inversify';
let InvRep1 = class InvRep1 {
};
InvRep1 = __decorate([
    injectable()
], InvRep1);
let InvRep2 = class InvRep2 {
};
InvRep2 = __decorate([
    injectable()
], InvRep2);
let InvRep3 = class InvRep3 {
};
InvRep3 = __decorate([
    injectable()
], InvRep3);
let InvSvc1 = class InvSvc1 {
    repo1;
    repo2;
    repo3;
    constructor(repo1, repo2, repo3) {
        this.repo1 = repo1;
        this.repo2 = repo2;
        this.repo3 = repo3;
    }
};
InvSvc1 = __decorate([
    injectable(),
    __metadata("design:paramtypes", [InvRep1,
        InvRep2,
        InvRep3])
], InvSvc1);
let InvSvc2 = class InvSvc2 {
};
InvSvc2 = __decorate([
    injectable()
], InvSvc2);
let InvSvc3 = class InvSvc3 {
};
InvSvc3 = __decorate([
    injectable()
], InvSvc3);
let InvSvc4 = class InvSvc4 {
};
InvSvc4 = __decorate([
    injectable()
], InvSvc4);
let InvSvc5 = class InvSvc5 {
};
InvSvc5 = __decorate([
    injectable()
], InvSvc5);
let InvSvc6 = class InvSvc6 {
};
InvSvc6 = __decorate([
    injectable()
], InvSvc6);
let InvRoot = class InvRoot {
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
InvRoot = __decorate([
    injectable(),
    __metadata("design:paramtypes", [InvSvc1,
        InvSvc2,
        InvSvc3,
        InvSvc4,
        InvSvc5,
        InvSvc6])
], InvRoot);
export { InvRoot };
let InvRootSingleton = class InvRootSingleton {
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
InvRootSingleton = __decorate([
    injectable(),
    __metadata("design:paramtypes", [InvSvc1,
        InvSvc2,
        InvSvc3,
        InvSvc4,
        InvSvc5,
        InvSvc6])
], InvRootSingleton);
export { InvRootSingleton };
const inv = new Container();
inv.bind(InvRep1).toSelf();
inv.bind(InvRep2).toSelf();
inv.bind(InvRep3).toSelf();
inv.bind(InvSvc1).toSelf();
inv.bind(InvSvc2).toSelf();
inv.bind(InvSvc3).toSelf();
inv.bind(InvSvc4).toSelf();
inv.bind(InvSvc5).toSelf();
inv.bind(InvSvc6).toSelf();
inv.bind(InvRoot).toSelf();
inv.bind(InvRootSingleton).toSelf().inSingletonScope();
export { inv };
