class StudyPcm extends AudioWorkletProcessor {
 constructor(){super();this.parts=[];this.size=0;this.start=0;this.port.onmessage=()=>this.flush();}
 flush(){if(!this.size)return;const samples=new Float32Array(this.size);let at=0;for(const part of this.parts){samples.set(part,at);at+=part.length;}this.port.postMessage({start:this.start,samples},[samples.buffer]);this.parts=[];this.size=0;}
 process(inputs,outputs){const channels=inputs[0];if(!channels?.length)return true;const n=channels[0].length;if(!this.size)this.start=currentTime;const mono=new Float32Array(n);for(const channel of channels)for(let i=0;i<n;i++)mono[i]+=channel[i]/channels.length;this.parts.push(mono);this.size+=n;if(this.size>=sampleRate*.2)this.flush();for(const channel of outputs[0]||[])channel.fill(0);return true;}
}
registerProcessor('study-pcm',StudyPcm);
