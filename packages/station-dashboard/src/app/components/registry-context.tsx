"use client";
import { createContext, useContext, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import NextLink from "next/link";
import { registryRequest } from "./registry-api.mjs";
const Context = createContext({ stationId: "", working: false, setWorking: (_value:boolean) => {} });
export function RegistryScope({stationId,children}:{stationId:string;children:ReactNode}) {
  const [working,setWorking]=useState(false);
  return <Context.Provider value={{stationId,working,setWorking}}>{children}</Context.Provider>;
}
export function useRegistry() {
  const context=useContext(Context);
  return useMemo(()=>({ ...context,
    href: (path:string) => {
      if (!context.stationId || !/^\/registry(?:\/|$|\?)/.test(path)) return path;
      const url=new URL(path,"http://local"); url.searchParams.set("registryStation",context.stationId); return url.pathname+url.search+url.hash;
    },
    request:(path:string,options:RequestInit={})=>registryRequest(path,options,context.stationId||undefined),
    post:(path:string,body:unknown)=>registryRequest(path,{method:"POST",body:JSON.stringify(body)},context.stationId||undefined),
  }),[context.stationId,context.working,context.setWorking]);
}
export function RegistryLink(props:ComponentProps<typeof NextLink>) {
  const {href}=useRegistry();
  return <NextLink {...props} href={typeof props.href==="string"?href(props.href):props.href}/>;
}
