import { describe, it, expect, vi } from "vitest";
import { mkdtemp, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { serve } from "./server.js";
import { Controller } from "./controller.js";
vi.mock("./startup.js",()=>({startupStatus:async()=>({supported:true,enabled:false}),setStartup:vi.fn()}));
describe("loopback control API",()=>{
  it("requires bearer auth and blocks CSRF, DNS rebinding, and oversize bodies",async()=>{
    const dir=await mkdtemp(join(tmpdir(),"usurp-local-http-"));
    const c={directory:dir,state:async()=>({status:"test"}),action:vi.fn(),tick:vi.fn(),shutdown:vi.fn()} as unknown as Controller;
    const service=await serve(c,0);const auth={authorization:`Bearer ${service.token}`};
    try{
      expect((await stat(join(dir,"runtime.json"))).mode&0o777).toBe(0o600);
      expect((await fetch(`${service.origin}/api/state`)).status).toBe(401);
      const r=await fetch(`${service.origin}/api/state`,{headers:auth});expect(r.status).toBe(200);expect(r.headers.get("access-control-allow-origin")).toBeNull();expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect((await fetch(`${service.origin}/api/action`,{method:"POST",headers:{...auth,origin:"https://evil.example","content-type":"application/json"},body:JSON.stringify({action:"pair"})})).status).toBe(403);
      expect((await fetch(`${service.origin}/api/action`,{method:"POST",headers:{...auth,"content-type":"text/plain"},body:"{}"})).status).toBe(415);
      const rebinding=await new Promise<number|undefined>(resolve=>{httpRequest(service.origin+"/api/state",{headers:{...auth,host:"evil.example"}},r=>{r.resume();resolve(r.statusCode);}).end();});expect(rebinding).toBe(403);
      expect((await fetch(`${service.origin}/api/action`,{method:"POST",headers:{...auth,"content-type":"application/json"},body:"x".repeat(9000)})).status).toBe(413);
      expect(c.action).not.toHaveBeenCalled();
      expect((await fetch(`${service.origin}/api/action`,{method:"POST",headers:{...auth,"content-type":"application/json"},body:JSON.stringify({action:"pause"})})).status).toBe(200);expect(c.action).toHaveBeenCalledWith("pause",undefined);
    }finally{await service.close();}
    await expect(stat(join(dir,"runtime.json"))).rejects.toThrow();
  });
});
