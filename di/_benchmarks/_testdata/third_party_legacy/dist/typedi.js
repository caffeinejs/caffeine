var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Service } from 'typedi';
import { Container } from 'typedi';
let TypeRep1 = class TypeRep1 {
};
TypeRep1 = __decorate([
    Service({ transient: true })
], TypeRep1);
let TypeRep2 = class TypeRep2 {
};
TypeRep2 = __decorate([
    Service({ transient: true })
], TypeRep2);
let TypeRep3 = class TypeRep3 {
};
TypeRep3 = __decorate([
    Service({ transient: true })
], TypeRep3);
let TypeSvc1 = class TypeSvc1 {
    repo1;
    repo2;
    repo3;
    constructor(repo1, repo2, repo3) {
        this.repo1 = repo1;
        this.repo2 = repo2;
        this.repo3 = repo3;
    }
};
TypeSvc1 = __decorate([
    Service({ transient: true }),
    __metadata("design:paramtypes", [TypeRep1,
        TypeRep2,
        TypeRep3])
], TypeSvc1);
let TypeSvc2 = class TypeSvc2 {
};
TypeSvc2 = __decorate([
    Service({ transient: true })
], TypeSvc2);
let TypeSvc3 = class TypeSvc3 {
};
TypeSvc3 = __decorate([
    Service({ transient: true })
], TypeSvc3);
let TypeSvc4 = class TypeSvc4 {
};
TypeSvc4 = __decorate([
    Service({ transient: true })
], TypeSvc4);
let TypeSvc5 = class TypeSvc5 {
};
TypeSvc5 = __decorate([
    Service({ transient: true })
], TypeSvc5);
let TypeSvc6 = class TypeSvc6 {
};
TypeSvc6 = __decorate([
    Service({ transient: true })
], TypeSvc6);
let TypeRoot = class TypeRoot {
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
TypeRoot = __decorate([
    Service({ transient: true }),
    __metadata("design:paramtypes", [TypeSvc1,
        TypeSvc2,
        TypeSvc3,
        TypeSvc4,
        TypeSvc5,
        TypeSvc6])
], TypeRoot);
export { TypeRoot };
let TypeSingletonRoot = class TypeSingletonRoot {
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
TypeSingletonRoot = __decorate([
    Service(),
    __metadata("design:paramtypes", [TypeSvc1,
        TypeSvc2,
        TypeSvc3,
        TypeSvc4,
        TypeSvc5,
        TypeSvc6])
], TypeSingletonRoot);
export { TypeSingletonRoot };
export { Container as typeContainer };
