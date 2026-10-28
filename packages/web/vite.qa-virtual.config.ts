import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config';
export default mergeConfig(base, defineConfig({base:'/qa-virtual-text/',publicDir:false,build:{outDir:'/opt/excelmanus-next/packages/web/dist/qa-virtual-text',emptyOutDir:true,rollupOptions:{input:'qa-virtual-preview.html'}}}));
