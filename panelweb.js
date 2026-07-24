// ==========================================================================
// 🛠️ CONFIGURACIÓN GLOBAL Y SEGURIDAD DEL SCADA AQUASHIELD
// ==========================================================================
const ESP32_IP = "10.183.179.148";
const WEBSOCKET_URL = `ws://${ESP32_IP}:81`;
let socket;

// CONFIGURACIÓN TELEGRAM
const TELEGRAM_BOT_TOKEN = "TU_BOT_TOKEN_AQUI"; 
const TELEGRAM_CHAT_ID = "TU_CHAT_ID_AQUI";

// CONFIGURACIÓN WHATSAPP (CallMeBot)
const WHATSAPP_PHONE = "TU_NUMERO_CON_CODIGO_DE_PAIS"; 
const WHATSAPP_API_KEY = "TU_API_KEY_DE_CALLMEBOT";

// HABITACIONES DEFINIDAS EN TU MAQUETA
const HABITACIONES = [
    { id: "cocina", nombre: "Cocina", pin: "A0" },
    { id: "comedor", nombre: "Comedor", pin: "A1" },
    { id: "dormitorio1", nombre: "Dormitorio 1", pin: "A2" },
    { id: "living", nombre: "Living", pin: "A3" },
    { id: "bano", nombre: "Baño", pin: "A4" },
    { id: "dormitorio2", nombre: "Dormitorio 2", pin: "A5" }
];

const TAMANO_FILTRO = 2;
let historialLecturas = Array(6).fill(null).map(() => []);

// UMBRALES DE LECTURA (Basado en ADC 0-1023 / Ajustar si tu micro envía 0-100%)
const UMBRAL_FUGA = 25;      // Nivel a partir del cual se considera presencia de agua
const LIMITE_CORTO = 1020;    // Detección de circuito abierto / VCC directo
const LIMITE_GND = -1;        // Detección de cable desconectado / GND directo

let bombaActiva = false;
let alertaActivaGlobal = false;

// Variables para el motor 3D y animación
let scene3d, camera3d, renderer3d, controls3d;
let meshesHabitaciones = {}; 
let pipeMeshes = [];
let sensorLedMeshes = {};
let chipLeds = [];
let pipeEmissiveIntensity = 0.6;
let pipePulseDirection = 1;

// ==========================================================================
// 🧭 CONTROL DE NAVEGACIÓN
// ==========================================================================
function cambiarPagina(paginaId) {
    try {
        document.querySelectorAll(".tab-content").forEach(content => {
            content.classList.remove("active");
        });
        document.querySelectorAll(".nav-btn").forEach(btn => {
            btn.classList.remove("active");
        });
        
        const targetTab = document.getElementById(`pag-${paginaId}`);
        if (targetTab) targetTab.classList.add("active");
        
        document.querySelectorAll(".nav-btn").forEach(btn => {
            const onclickAttr = btn.getAttribute("onclick");
            if (onclickAttr && onclickAttr.includes(`'${paginaId}'`)) {
                btn.classList.add("active");
            }
        });

        // Forzamos al navegador a disparar un resize para despertar Three.js
        setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
        }, 80);

    } catch (error) {
        console.error("[TABS-ERROR]", error);
    }
}

// ==========================================================================
// 🔌 CONEXIÓN WEBSOCKETS
// ==========================================================================
function conectarWebSocket() {
    try {
        socket = new WebSocket(WEBSOCKET_URL);
        socket.onopen = () => {
            const el = document.getElementById("estado-conexion");
            if (el) { el.innerText = "ONLINE"; el.className = "estado online"; }
        };
        socket.onclose = () => {
            const el = document.getElementById("estado-conexion");
            if (el) { el.innerText = "OFFLINE"; el.className = "estado offline"; }
            setTimeout(conectarWebSocket, 5000);
        };
        socket.onmessage = (event) => { procesarDatosSensores(event.data); };
    } catch (err) {
        console.warn("[WEBSOCKET] Enlace no disponible en modo offline.");
    }
}

// ==========================================================================
// ⚙️ PROCESAMIENTO Y FILTRADO DIGITAL
// ==========================================================================
function procesarDatosSensores(datosRaw) {
    try {
        const lecturasActuales = datosRaw.split(",").map(Number);
        if (lecturasActuales.length !== 6) return;

        let promediosFiltrados = [];
        let estadosDiagnostico = [];

        for (let i = 0; i < 6; i++) {
            let valorActual = lecturasActuales[i];

            // 1. Añadir al historial y promediar primero para suavizar ruido
            historialLecturas[i].push(valorActual);
            if (historialLecturas[i].length > TAMANO_FILTRO) {
                historialLecturas[i].shift();
            }

            let suma = historialLecturas[i].reduce((a, b) => a + b, 0);
            let promedio = Math.round(suma / historialLecturas[i].length);
            promediosFiltrados.push(promedio);

            // 2. Evaluar desconexión sólo si supera los límites de hardware reales
            let estadoSensor = "OK";
            if (promedio >= LIMITE_CORTO || promedio < LIMITE_GND) {
                estadoSensor = "ERROR";
            }
            estadosDiagnostico.push(estadoSensor);

            const elementVal = document.getElementById(`val-${HABITACIONES[i].id}`);
            if (elementVal) elementVal.innerText = promedio;
        }

        actualizarPaginaDiagnostico(lecturasActuales, estadosDiagnostico);
        analizarYTomarAcciones(promediosFiltrados, estadosDiagnostico);
    } catch (error) {
        console.error("[DATA-ERROR]", error);
    }
}

// ==========================================================================
// 🧠 INTELIGENCIA HEURÍSTICA Y MÁQUINA DE ESTADOS
// ==========================================================================
function analizarYTomarAcciones(promedios, diagnosticos) {
    try {
        let hayFalloDiagnostico = diagnosticos.includes("ERROR");
        let habitacionConFuga = null;
        let maxRuido = -1;
        let indiceFuga = -1;

        for (let i = 0; i < 6; i++) {
            if (diagnosticos[i] === "OK" && promedios[i] > UMBRAL_FUGA && promedios[i] > maxRuido) {
                maxRuido = promedios[i];
                habitacionConFuga = HABITACIONES[i];
                indiceFuga = i;
            }
        }

        let probabilidadFuga = 0;
        let validacionPorVecinos = false;

        if (maxRuido > 0 && indiceFuga !== -1) {
            // Conversión de escala adaptativa a Porcentaje (%)
            const maxRango = maxRuido <= 100 ? 100 : 1023;
            probabilidadFuga = Math.min(Math.round((maxRuido / maxRango) * 100), 100);
            
            let vecinoIzquierdo = indiceFuga > 0 ? promedios[indiceFuga - 1] : 0;
            let vecinoDerecho = indiceFuga < 5 ? promedios[indiceFuga + 1] : 0;

            if (vecinoIzquierdo > (UMBRAL_FUGA * 0.4) || vecinoDerecho > (UMBRAL_FUGA * 0.4)) {
                validacionPorVecinos = true;
                probabilidadFuga = Math.min(probabilidadFuga + 10, 100);
            }
        }

        const aiPorcentajeElement = document.getElementById("ai-porcentaje");
        if (aiPorcentajeElement) aiPorcentajeElement.innerText = `${probabilidadFuga}%`;

        let estadoGlobal = "NORMAL";
        if (hayFalloDiagnostico) {
            estadoGlobal = "DIAGNOSTICO_FALLIDO";
            enviarComandoAlArduino("Y"); // LED Amarillo en Hardware
            alertaActivaGlobal = false;
        } else if (habitacionConFuga) {
            estadoGlobal = "FUGA_DETECTADA";
            enviarComandoAlArduino("R"); // LED Rojo en Hardware
            if (!alertaActivaGlobal) {
                alertaActivaGlobal = true;
                dispararProtocoloNotificaciones(habitacionConFuga.nombre, probabilidadFuga);
            }
        } else {
            estadoGlobal = "NORMAL";
            enviarComandoAlArduino("G"); // LED Verde en Hardware
            alertaActivaGlobal = false;
        }

        actualizarPaginaInicio(estadoGlobal, diagnosticos);
        actualizarPaginaTelemetriaVisual(estadoGlobal, habitacionConFuga, diagnosticos);
        actualizarPaginaAI_Mejorada(probabilidadFuga, habitacionConFuga, validacionPorVecinos);
    } catch (error) {
        console.error("[CORE-ERROR]", error);
    }
}

// ==========================================================================
// 🎨 ACTUALIZADORES DE INTERFAZ 2D Y ESTADOS
// ==========================================================================
function actualizarPaginaInicio(estado, diagnosticos) {
    try {
        const estTexto = document.getElementById("status-general-texto");
        const countOk = diagnosticos.filter(d => d === "OK").length;
        
        const numSensores = document.getElementById("num-sensores-ok");
        if (numSensores) numSensores.innerText = `${countOk}/6`;
        
        const bombaTexto = document.getElementById("bomba-estado-texto");
        if (bombaTexto) {
            bombaTexto.innerText = bombaActiva ? "ACTIVA" : "APAGADA";
            bombaTexto.className = bombaActiva ? "valor-metrica text-cyan" : "valor-metrica text-red";
        }

        if (estTexto) {
            if (estado === "FUGA_DETECTADA") {
                estTexto.innerText = "🚨 ALERTA DE FUGA ACTIVA";
                estTexto.className = "texto-peligro";
            } else if (estado === "DIAGNOSTICO_FALLIDO") {
                estTexto.innerText = "⚠ ANOMALÍA EN TRANSDUCTORES";
                estTexto.className = "texto-diagnostico";
            } else {
                estTexto.innerText = "SISTEMA NOMINAL (OK)";
                estTexto.className = "texto-normal";
            }
        }
    } catch (err) { console.warn(err); }
}

function actualizarPaginaTelemetriaVisual(estado, habitacionFuga, diagnosticos) {
    try {
        HABITACIONES.forEach((hab, index) => {
            let estadoClase = "normal";
            let colorHex = 0x00f0ff; 
            let ledColor = 0x00ffcc; 

            if (diagnosticos[index] !== "OK") {
                estadoClase = "error";
                colorHex = 0xffe600; 
                ledColor = 0xffaa00;
            } else if (habitacionFuga && habitacionFuga.id === hab.id) {
                estadoClase = "alerta";
                colorHex = 0xff0055; 
                ledColor = 0xff0033;
            }

            // Cambiar color del piso flotante en Three.js
            if (meshesHabitaciones && meshesHabitaciones[hab.id]) {
                const item3D = meshesHabitaciones[hab.id];
                if (item3D.mesh && item3D.mesh.material) {
                    item3D.mesh.material.color.setHex(colorHex);
                    item3D.mesh.material.opacity = (estadoClase === "alerta") ? 0.75 : 0.25;
                }
            }

            // Cambiar color del LED del Sensor Físico en 3D
            if (sensorLedMeshes && sensorLedMeshes[hab.id]) {
                sensorLedMeshes[hab.id].material.color.setHex(ledColor);
                sensorLedMeshes[hab.id].material.emissive.setHex(ledColor);
            }
        });

        // Actualizar Lista Lateral 2D
        let htmlLista = "";
        HABITACIONES.forEach((hab, index) => {
            let estadoClase = diagnosticos[index] !== "OK" ? "error" : (habitacionFuga && habitacionFuga.id === hab.id ? "alerta" : "normal");
            let estadoTexto = diagnosticos[index] !== "OK" ? "FALLA DE HARDWARE" : (habitacionFuga && habitacionFuga.id === hab.id ? "FUGA DETECTADA" : "NOMINAL OK");
            htmlLista += `
                <div class="item-estado-3d ${estadoClase}">
                    <span>${hab.nombre.toUpperCase()} (${hab.pin})</span>
                    <strong>${estadoTexto}</strong>
                </div>
            `;
        });
        const listaContainer = document.getElementById("habitaciones-lista-3d");
        if (listaContainer) listaContainer.innerHTML = htmlLista;

        // Banner Superior
        let banner = document.getElementById("alerta-banner");
        if (banner) {
            if (estado === "FUGA_DETECTADA" && habitacionFuga) {
                banner.innerText = `🚨 ALERTA: RESONANCIA CRÍTICA DETECTADA EN ${habitacionFuga.nombre.toUpperCase()} 🚨`;
                banner.className = "banner peligro";
            } else if (estado === "DIAGNOSTICO_FALLIDO") {
                banner.innerText = "⚠ ADVERTENCIA: FALLA EN PRUEBA DE IMPEDANCIA DE SENSORES ⚠";
                banner.className = "banner advertencia";
            } else {
                banner.innerText = "✅ SISTEMA EN VIGILANCIA. NO SE DETECTAN ANOMALÍAS.";
                banner.className = "banner seguro";
            }
        }
    } catch (err) { console.warn(err); }
}

function actualizarPaginaDiagnostico(lecturas, diagnosticos) {
    try {
        const tablaCuerpo = document.getElementById("tabla-diagnostico-cuerpo");
        if (!tablaCuerpo) return;

        let htmlContenido = "";
        HABITACIONES.forEach((hab, idx) => {
            const valorRaw = lecturas[idx];
            const estado = diagnosticos[idx];
            const maxVal = valorRaw <= 100 ? 100 : 1023;
            const voltajeSimulado = ((valorRaw / maxVal) * 5).toFixed(2);
            const impSimulada = estado === "ERROR" ? "∞ (Abierto)" : "Approx. 8.2 kΩ";
            const alimentacionTexto = estado === "ERROR" ? "PÉRDIDA DE SEÑAL / CORTO" : "VCC 5V NOMINAL";

            htmlContenido += `
                <tr>
                    <td>${hab.id.toUpperCase()}</td>
                    <td>${hab.nombre}</td>
                    <td>${hab.pin}</td>
                    <td style="color: var(--accent-blue)">${voltajeSimulado} V</td>
                    <td>${impSimulada}</td>
                    <td>
                        <span class="status-tag ${estado === "OK" ? "ok" : "error"}">
                            ${alimentacionTexto}
                        </span>
                    </td>
                </tr>
            `;
        });
        tablaCuerpo.innerHTML = htmlContenido;
    } catch (err) { console.warn(err); }
}

let ultimoLog = "";
function actualizarPaginaAI_Mejorada(probabilidad, habitacion, validado) {
    try {
        const displayAnalisis = document.getElementById("ai-diagnostico-analisis");
        const terminal = document.getElementById("ai-log");
        
        if (displayAnalisis) {
            if (probabilidad > 70) {
                let mensajeVecinos = validado ? "CONFIRMADO POR CORRELACIÓN DE VECTORES ADYACENTES" : "ALERTA AISLADA (FALSO POSITIVO EN REVISIÓN)";
                displayAnalisis.innerText = `ALERTA CRÍTICA // SECTOR: ${habitacion ? habitacion.nombre.toUpperCase() : 'DESCONOCIDO'} // ${mensajeVecinos}`;
                displayAnalisis.style.color = "var(--accent-red)";
                if (terminal && habitacion) escribirTerminalLog(terminal, `[IA-ANALYSIS] Anomalía del ${probabilidad}% en ${habitacion.nombre}. Filtro espacial: ${validado ? 'CONFIRMADO' : 'SOSPECHOSO'}.`);
            } else if (probabilidad > 40) {
                displayAnalisis.innerText = "SITUACIÓN BAJO ANÁLISIS // PATRÓN EN DESARROLLO";
                displayAnalisis.style.color = "var(--accent-yellow)";
                if (terminal && habitacion) escribirTerminalLog(terminal, `[IA-ANALYSIS] Fluctuación detectada en ${habitacion.nombre}. Monitoreando propagación estructural.`);
            } else {
                displayAnalisis.innerText = "SISTEMA ESTABLE // RED EN VIGILANCIA NOMINAL";
                displayAnalisis.style.color = "var(--accent-green)";
            }
        }
    } catch (err) { console.warn(err); }
}

function escribirTerminalLog(terminalElement, mensaje) {
    try {
        if (ultimoLog === mensaje) return;
        ultimoLog = mensaje;
        const tiempo = new Date().toLocaleTimeString();
        terminalElement.innerHTML += `[${tiempo}] ${mensaje}<br>`;
        terminalElement.scrollTop = terminalElement.scrollHeight;
    } catch (err) {}
}

// ==========================================================================
// 🕹️ CONTROLES MANUALES (BOMBA Y COMANDOS)
// ==========================================================================
function controlarBomba(encender) {
    try {
        bombaActiva = encender;
        const comando = encender ? "P1" : "P0";
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(comando);
        }
        
        const btnOn = document.getElementById("btn-bomba-on");
        const btnOff = document.getElementById("btn-bomba-off");
        const txtBomba = document.getElementById("bomba-estado-texto");

        if (btnOn) btnOn.className = encender ? "btn active" : "btn";
        if (btnOff) btnOff.className = !encender ? "btn active" : "btn";
        if (txtBomba) txtBomba.innerText = encender ? "ACTIVA" : "APAGADA";
    } catch (error) { console.error(error); }
}

function enviarComandoAlArduino(comando) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(comando);
    } else {
        console.log(`[WS-ENLACE] Comando enviado: ${comando} (Modo Simulación)`);
    }
}

// ==========================================================================
// 📱 SERVICIOS DE NOTIFICACIONES EXTERNAS
// ==========================================================================
function solicitarPermisosNotificacion() {
    try {
        if ("Notification" in window) {
            Notification.requestPermission().then(permiso => {
                console.log(`[SYS-NOTIFY] Permisos del Navegador: ${permiso}`);
            });
        }
    } catch (err) {}
}

function dispararProtocoloNotificaciones(habitacion, probabilidad) {
    try {
        const mensaje = `⚠️ ALERTA AQUASHIELD: Probabilidad de fuga del ${probabilidad}% detectada en el sector: ${habitacion.toUpperCase()}.`;
        mostrarNotificacionWeb(mensaje);
        enviarMensajeTelegram(mensaje);
        enviarMensajeWhatsApp(mensaje);
    } catch (err) { console.error(err); }
}

function mostrarNotificacionWeb(mensaje) {
    try {
        if ("Notification" in window && Notification.permission === "granted") {
            new Notification("🚨 ALERTA CRÍTICA AQUASHIELD", {
                body: mensaje,
                icon: "https://cdn-icons-png.flaticon.com/512/4230/4230756.png"
            });
        }
    } catch (err) {}
}

function enviarMensajeTelegram(mensaje) {
    try {
        if (TELEGRAM_BOT_TOKEN === "TU_BOT_TOKEN_AQUI") return;
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: mensaje })
        });
    } catch (err) {}
}

function enviarMensajeWhatsApp(mensaje) {
    try {
        if (WHATSAPP_API_KEY === "TU_API_KEY_DE_CALLMEBOT") return;
        const mensajeCodificado = encodeURIComponent(mensaje);
        const url = `https://api.callmebot.com/whatsapp.php?phone=${WHATSAPP_PHONE}&text=${mensajeCodificado}&apikey=${WHATSAPP_API_KEY}`;
        fetch(url, { mode: 'no-cors' });
    } catch (err) {}
}

// ==========================================================================
// 🌐 MOTOR GRÁFICO 3D (GEMELO DIGITAL CON THREE.JS)
// ==========================================================================
function inicializarEntorno3D() {
    try {
        const container = document.getElementById("canvas-3d-container");
        if (!container) return;

        if (typeof THREE === 'undefined') {
            container.innerHTML = `<div style="color:#ff0055;padding:25px;text-align:center;">⚠️ ERROR DE LIBRERÍA THREE.JS NO DETECTADA</div>`;
            return;
        }

        if (container.clientHeight === 0) {
            container.style.height = "550px";
            container.style.minHeight = "450px";
            container.style.position = "relative";
        }

        // 1. Escena
        scene3d = new THREE.Scene();
        scene3d.background = new THREE.Color(0x1e2530); 
        scene3d.fog = new THREE.Fog(0x1e2530, 80, 250);

        // 2. Cámara
        camera3d = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
        camera3d.position.set(45, 42, 72); 

        // 3. Renderizador
        renderer3d = new THREE.WebGLRenderer({ antialias: true });
        renderer3d.setSize(container.clientWidth, container.clientHeight);
        renderer3d.setPixelRatio(window.devicePixelRatio);
        container.innerHTML = ""; 
        container.appendChild(renderer3d.domElement);

        // 4. Controles Orbit
        if (THREE.OrbitControls) {
            controls3d = new THREE.OrbitControls(camera3d, renderer3d.domElement);
            controls3d.enableDamping = true;
            controls3d.dampingFactor = 0.05;
            controls3d.maxPolarAngle = Math.PI / 2 - 0.05;
            controls3d.target.set(0, 5, 10); 
        }

        // 5. Luces
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
        scene3d.add(ambientLight);

        const dirLight = new THREE.DirectionalLight(0x00f0ff, 1.0);
        dirLight.position.set(20, 35, 20);
        scene3d.add(dirLight);

        // 6. Plataforma Base
        const platformGeo = new THREE.BoxGeometry(60, 0.5, 60);
        const platformMat = new THREE.MeshPhongMaterial({ color: 0x0f1522, shininess: 30 });
        const platform = new THREE.Mesh(platformGeo, platformMat);
        platform.position.set(0, -0.25, 0); 
        scene3d.add(platform);

        const gridHelper = new THREE.GridHelper(60, 30, 0x00f0ff, 0x3a485c);
        gridHelper.position.set(0, 0.05, 0);
        scene3d.add(gridHelper);

        // 7. Base Elevada
        const baseGeo = new THREE.BoxGeometry(60, 7, 40);
        const baseMat = new THREE.MeshPhongMaterial({
            color: 0x111a2e,
            transparent: true,
            opacity: 0.4,
            shininess: 50,
            depthWrite: false 
        });
        const houseBase = new THREE.Mesh(baseGeo, baseMat);
        houseBase.position.set(0, 3.5, 10);
        scene3d.add(houseBase);

        const baseEdges = new THREE.EdgesGeometry(baseGeo);
        const baseWire = new THREE.LineSegments(baseEdges, new THREE.LineBasicMaterial({ color: 0x00d2ff }));
        houseBase.add(baseWire);

        // 8. Zona Electrónica Frontal (PCB, Arduino, ESP32)
        const pcbGeo = new THREE.BoxGeometry(60, 0.2, 20);
        const pcbMat = new THREE.MeshPhongMaterial({ color: 0x0b1d12, shininess: 40 }); 
        const pcb = new THREE.Mesh(pcbGeo, pcbMat);
        pcb.position.set(0, 0.1, -20);
        scene3d.add(pcb);

        // Arduino Uno
        const arduinoGroup = new THREE.Group();
        const boardUno = new THREE.Mesh(new THREE.BoxGeometry(10, 0.4, 7), new THREE.MeshPhongMaterial({ color: 0x00558f }));
        arduinoGroup.add(boardUno);
        const atmega = new THREE.Mesh(new THREE.BoxGeometry(4.5, 0.4, 1.2), new THREE.MeshPhongMaterial({ color: 0x111111 }));
        atmega.position.set(1, 0.4, 0.8);
        arduinoGroup.add(atmega);
        const usb = new THREE.Mesh(new THREE.BoxGeometry(3, 1.4, 2), new THREE.MeshPhongMaterial({ color: 0xaaaaaa }));
        usb.position.set(-4, 0.7, -2);
        arduinoGroup.add(usb);
        const ledUno = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 8), new THREE.MeshBasicMaterial({ color: 0x00ff00 }));
        ledUno.position.set(4, 0.35, 2.5);
        arduinoGroup.add(ledUno);
        chipLeds.push(ledUno);
        arduinoGroup.position.set(-20, 0.5, -18); 
        scene3d.add(arduinoGroup);

        // ESP32
        const espGroup = new THREE.Group();
        const boardEsp = new THREE.Mesh(new THREE.BoxGeometry(7, 0.4, 4.5), new THREE.MeshPhongMaterial({ color: 0x111111 }));
        espGroup.add(boardEsp);
        const shield = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.4, 3.2), new THREE.MeshPhongMaterial({ color: 0xdddddd }));
        shield.position.set(1, 0.4, 0);
        espGroup.add(shield);
        const ledEsp = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 8), new THREE.MeshBasicMaterial({ color: 0x00aaff }));
        ledEsp.position.set(-2.5, 0.35, 1.5);
        espGroup.add(ledEsp);
        chipLeds.push(ledEsp);
        espGroup.position.set(-5, 0.5, -18); 
        scene3d.add(espGroup);

        // 9. Generador de Etiquetas 2D en Sprite 3D
        function crearEtiquetaTexto(texto) {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = 512;
            canvas.height = 128;
            ctx.fillStyle = 'rgba(10, 14, 22, 0.9)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.strokeStyle = '#00f0ff';
            ctx.lineWidth = 6;
            ctx.strokeRect(0, 0, canvas.width, canvas.height);
            ctx.font = 'bold 44px monospace';
            ctx.fillStyle = '#00f0ff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(texto, canvas.width / 2, canvas.height / 2);

            const texture = new THREE.CanvasTexture(canvas);
            const spriteMaterial = new THREE.SpriteMaterial({ map: texture, transparent: true });
            const sprite = new THREE.Sprite(spriteMaterial);
            sprite.scale.set(12, 3, 1);
            return sprite;
        }

        // 10. Re-mapeo de Habitaciones y Sensores
        const NUEVA_CONFIG_HABITACIONES = {
            cocina:      { cx: -21, cz: 21,   w: 18, d: 18, name: "Cocina" },
            dormitorio1: { cx: 0,   cz: 21,   w: 24, d: 18, name: "Dormitorio 1" },
            bano:        { cx: 21,  cz: 21,   w: 18, d: 18, name: "Baño" },
            comedor:     { cx: -17, cz: -2.5, w: 26, d: 15, name: "Comedor" },
            living:      { cx: 4,   cz: -2.5, w: 16, d: 15, name: "Living" },
            dormitorio2: { cx: 21,  cz: -2.5, w: 18, d: 15, name: "Dormitorio 2" }
        };

        HABITACIONES.forEach(hab => {
            const cfg = NUEVA_CONFIG_HABITACIONES[hab.id];
            if (!cfg) return;

            // Malla del piso
            const geometry = new THREE.BoxGeometry(cfg.w, 0.2, cfg.d);
            const material = new THREE.MeshPhongMaterial({
                color: 0x00f0ff,
                transparent: true,
                opacity: 0.15,
                shininess: 80,
                depthWrite: false 
            });

            const mesh = new THREE.Mesh(geometry, material);
            mesh.position.set(cfg.cx, 7.1, cfg.cz);
            scene3d.add(mesh);

            // Label Flotante
            const etiqueta = crearEtiquetaTexto(cfg.name.toUpperCase());
            etiqueta.position.set(cfg.cx, 26, cfg.cz);
            scene3d.add(etiqueta);

            meshesHabitaciones[hab.id] = { mesh: mesh, etiqueta: etiqueta };

            // Sensor Físico LED en Habitación
            const sensorGeo = new THREE.SphereGeometry(0.7, 16, 16);
            const sensorMat = new THREE.MeshPhongMaterial({ color: 0x00ffcc, emissive: 0x00ffcc, emissiveIntensity: 0.8 });
            const sensorMesh = new THREE.Mesh(sensorGeo, sensorMat);
            sensorMesh.position.set(cfg.cx, 7.6, cfg.cz);
            scene3d.add(sensorMesh);
            sensorLedMeshes[hab.id] = sensorMesh;
        });

        // 11. Muros
        const wallMat = new THREE.MeshPhongMaterial({
            color: 0x0f1522, transparent: true, opacity: 0.85, shininess: 30, depthWrite: false 
        });
        const wallWireMat = new THREE.LineBasicMaterial({ color: 0x3a4f6e });

        function construirMuro(ancho, alto, profundidad, x, y, z) {
            const geo = new THREE.BoxGeometry(ancho, alto, profundidad);
            const mesh = new THREE.Mesh(geo, wallMat);
            mesh.position.set(x, y, z);
            scene3d.add(mesh);
            const edges = new THREE.EdgesGeometry(geo);
            const wire = new THREE.LineSegments(edges, wallWireMat);
            mesh.add(wire);
        }

        construirMuro(60, 15, 0.4, 0, 14.5, 30);      // Fondo
        construirMuro(0.4, 15, 40, -30, 14.5, 10);    // Lat Izq
        construirMuro(0.4, 15, 40, 30, 14.5, 10);     // Lat Der
        construirMuro(4, 15, 0.4, -28, 14.5, -10);    // Frontal Izq
        construirMuro(52, 15, 0.4, 4, 14.5, -10);     // Frontal Der

        // Divisorios
        construirMuro(10, 15, 0.4, -7, 14.5, 12);
        construirMuro(17, 15, 0.4, 10.5, 14.5, 12);
        construirMuro(7, 15, 0.4, 26.5, 14.5, 12);
        construirMuro(13, 15, 0.4, 12.5, 14.5, 5);
        construirMuro(7, 15, 0.4, 26.5, 14.5, 5);
        construirMuro(0.4, 15, 18, -12, 14.5, 21);
        construirMuro(0.4, 15, 18, 12, 14.5, 21);
        construirMuro(0.4, 15, 15, 12, 14.5, -2.5);

        // 12. Puertas
        function crearPuertaEnMuro(x, z, rotY, esPrincipal = false) {
            const pGroup = new THREE.Group();
            const colorMarco = esPrincipal ? 0xff9900 : 0x00f0ff;
            const marcoMat = new THREE.MeshPhongMaterial({ color: colorMarco, transparent: true, opacity: 0.6, depthWrite: false });
            
            const posteIzq = new THREE.Mesh(new THREE.BoxGeometry(0.2, 10, 0.2), marcoMat); posteIzq.position.set(-2, 5, 0);
            const posteDer = new THREE.Mesh(new THREE.BoxGeometry(0.2, 10, 0.2), marcoMat); posteDer.position.set(2, 5, 0);
            pGroup.add(posteIzq, posteDer);

            const colorHoja = esPrincipal ? 0xcc7a29 : 0x8b5a2b; 
            const hoja = new THREE.Mesh(
                new THREE.BoxGeometry(3.8, 9.5, 0.1), 
                new THREE.MeshPhongMaterial({ color: colorHoja, transparent: true, opacity: 0.65, depthWrite: false })
            );

            hoja.position.set(-1.9, 5, 0); 
            hoja.rotation.y = esPrincipal ? -1.2 : 0.8;         
            pGroup.add(hoja);

            pGroup.position.set(x, 7, z);
            pGroup.rotation.y = rotY;
            scene3d.add(pGroup);
        }

        crearPuertaEnMuro(-24, -10, 0, true);   
        crearPuertaEnMuro(0, 12, 0);          
        crearPuertaEnMuro(21, 12, 0);         
        crearPuertaEnMuro(21, 5, 0);          

        // 13. Tubería Neón Conectada
        const pipePoints = [
            { x: -28, y: 3.5, z: -5 },   
            { x: 28,  y: 3.5, z: -5 },   
            { x: 28,  y: 3.5, z: 21 },    
            { x: 29.5, y: 3.5, z: 21 },    
            { x: 29.5, y: 15,  z: 21 },    
            { x: 29.5, y: 15,  z: 25 },    
            { x: 29.5, y: 3.5, z: 25 },    
            { x: 28,  y: 3.5, z: 25 },    
            { x: -28, y: 3.5, z: 25 },    
            { x: -29.5, y: 3.5, z: 25 },   
            { x: -29.5, y: 15,  z: 25 },   
            { x: -29.5, y: 15,  z: 21 },   
            { x: -29.5, y: 3.5, z: 21 },   
            { x: -28,  y: 3.5, z: 21 },    
            { x: -30,  y: 3.5, z: 21 }     
        ];

        function crearTubo(p1, p2, colorHex) {
            const v1 = new THREE.Vector3(p1.x, p1.y, p1.z);
            const v2 = new THREE.Vector3(p2.x, p2.y, p2.z);
            const distance = v1.distanceTo(v2);
            if (distance === 0) return;

            const geometry = new THREE.CylinderGeometry(0.35, 0.35, distance, 8);
            const material = new THREE.MeshPhongMaterial({
                color: colorHex, emissive: colorHex, emissiveIntensity: 0.6, transparent: true, opacity: 0.85
            });
            const cylinder = new THREE.Mesh(geometry, material);

            const dir = new THREE.Vector3().subVectors(v2, v1);
            cylinder.position.copy(v1).addScaledVector(dir, 0.5);
            cylinder.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());

            scene3d.add(cylinder);
            pipeMeshes.push(cylinder);
        }

        for (let i = 0; i < pipePoints.length - 1; i++) {
            crearTubo(pipePoints[i], pipePoints[i + 1], 0x00f0ff);
        }

        // Bucle de Animación 3D
        function animate3d() {
            requestAnimationFrame(animate3d);
            if (controls3d) controls3d.update();

            // Pulso de luminosidad en tuberías
            pipeEmissiveIntensity += 0.008 * pipePulseDirection;
            if (pipeEmissiveIntensity > 0.85) pipePulseDirection = -1;
            if (pipeEmissiveIntensity < 0.35) pipePulseDirection = 1;

            pipeMeshes.forEach(pipe => {
                if (pipe.material) pipe.material.emissiveIntensity = pipeEmissiveIntensity;
            });

            renderer3d.render(scene3d, camera3d);
        }
        animate3d();

        // Listener de Redimensionamiento
        window.addEventListener('resize', () => {
            if (!container || !renderer3d || !camera3d) return;
            const w = container.clientWidth;
            const h = container.clientHeight;
            if (w === 0 || h === 0) return;
            camera3d.aspect = w / h;
            camera3d.updateProjectionMatrix();
            renderer3d.setSize(w, h);
        });

    } catch (err) {
        console.error("[3D-INIT-ERROR]", err);
    }
}

// ==========================================================================
// 🚀 INICIALIZACIÓN AUTOMÁTICA DEL SISTEMA
// ==========================================================================
document.addEventListener("DOMContentLoaded", () => {
    conectarWebSocket();
    solicitarPermisosNotificacion();
    inicializarEntorno3D();
});