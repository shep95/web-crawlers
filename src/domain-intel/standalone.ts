// Optional local domain-audit service; the rest of Omnispider is not required to launch this entrypoint.
import Fastify from 'fastify';
import {registerDomainIntelRoutes} from '../http/domain-routes.js';
const app=Fastify({logger:false});
registerDomainIntelRoutes(app);
await app.listen({host:'127.0.0.1',port:Number(process.env.DOMAIN_INTEL_PORT||4188)});
console.log('Local domain audit service listening on loopback. Exact-value runs require authorized roots and the private audit key.');
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{void app.close().then(()=>process.exit(0));});
