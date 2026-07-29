var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
import { BindingScope, Context, inject, injectable } from '@loopback/context';
let LoopRep = class LoopRep {
};
LoopRep = __decorate([
    injectable()
], LoopRep);
let LoopSvc = class LoopSvc {
    repo;
    constructor(repo) {
        this.repo = repo;
    }
};
LoopSvc = __decorate([
    injectable(),
    __param(0, inject(LoopRep.name)),
    __metadata("design:paramtypes", [LoopRep])
], LoopSvc);
let LoopRoot = class LoopRoot {
    svc;
    constructor(svc) {
        this.svc = svc;
    }
};
LoopRoot = __decorate([
    injectable(),
    __param(0, inject(LoopSvc.name)),
    __metadata("design:paramtypes", [LoopSvc])
], LoopRoot);
export { LoopRoot };
let LoopSingletonRoot = class LoopSingletonRoot {
    svc;
    constructor(svc) {
        this.svc = svc;
    }
};
LoopSingletonRoot = __decorate([
    injectable(),
    __param(0, inject(LoopSvc.name)),
    __metadata("design:paramtypes", [LoopSvc])
], LoopSingletonRoot);
export { LoopSingletonRoot };
const ctx = new Context();
ctx.bind(LoopRep.name).toClass(LoopRep);
ctx.bind(LoopSvc.name).toClass(LoopSvc);
ctx.bind(LoopRoot.name).toClass(LoopRoot);
ctx.bind(LoopSingletonRoot.name).toClass(LoopSingletonRoot).inScope(BindingScope.SINGLETON);
export { ctx as loopCtx };
