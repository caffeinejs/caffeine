var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Injectable, Scope } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
let NestRep1 = class NestRep1 {
};
NestRep1 = __decorate([
    Injectable()
], NestRep1);
let NestRep2 = class NestRep2 {
};
NestRep2 = __decorate([
    Injectable()
], NestRep2);
let NestRep3 = class NestRep3 {
};
NestRep3 = __decorate([
    Injectable()
], NestRep3);
let NestSvc1 = class NestSvc1 {
    repo1;
    repo2;
    repo3;
    constructor(repo1, repo2, repo3) {
        this.repo1 = repo1;
        this.repo2 = repo2;
        this.repo3 = repo3;
    }
};
NestSvc1 = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [NestRep1,
        NestRep2,
        NestRep3])
], NestSvc1);
let NestSvc2 = class NestSvc2 {
};
NestSvc2 = __decorate([
    Injectable()
], NestSvc2);
let NestSvc3 = class NestSvc3 {
};
NestSvc3 = __decorate([
    Injectable()
], NestSvc3);
let NestSvc4 = class NestSvc4 {
};
NestSvc4 = __decorate([
    Injectable()
], NestSvc4);
let NestSvc5 = class NestSvc5 {
};
NestSvc5 = __decorate([
    Injectable()
], NestSvc5);
let NestSvc6 = class NestSvc6 {
};
NestSvc6 = __decorate([
    Injectable()
], NestSvc6);
let NestRoot = class NestRoot {
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
NestRoot = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [NestSvc1,
        NestSvc2,
        NestSvc3,
        NestSvc4,
        NestSvc5,
        NestSvc6])
], NestRoot);
export { NestRoot };
let NestTransientRoot = class NestTransientRoot {
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
NestTransientRoot = __decorate([
    Injectable({ scope: Scope.TRANSIENT }),
    __metadata("design:paramtypes", [NestSvc1,
        NestSvc2,
        NestSvc3,
        NestSvc4,
        NestSvc5,
        NestSvc6])
], NestTransientRoot);
export { NestTransientRoot };
let App = class App {
};
App = __decorate([
    Module({
        providers: [
            NestRep1,
            NestRep2,
            NestRep3,
            NestSvc1,
            NestSvc2,
            NestSvc3,
            NestSvc4,
            NestSvc5,
            NestSvc6,
            NestRoot,
            NestTransientRoot,
        ],
    })
], App);
export { App };
export async function bootstrap() {
    return await NestFactory.createApplicationContext(App, { logger: false });
}
