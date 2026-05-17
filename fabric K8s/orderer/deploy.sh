#!/bin/bash
#
# deploy.sh — Despliega las CAs de Fabric en Kubernetes
# Uso: ./deploy.sh [up|down|status|logs]
#
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $1"; }
step()  { echo -e "\n${CYAN}▶ $1${NC}"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

NAMESPACE=fabric
MANIFESTS_DIR="$(cd "$(dirname "$0")" && pwd)"

# Verifica kubectl
which kubectl > /dev/null 2>&1 || error "kubectl no encontrado"

# Verifica conexión al cluster
kubectl cluster-info > /dev/null 2>&1 || error "No hay conexión al cluster de Kubernetes"

# ── Espera a que un deployment esté Ready ────────────────────────────────────
waitDeployment() {
  local NAME=$1
  info "Esperando deployment/$NAME..."
  kubectl rollout status deployment/"$NAME" \
    -n "$NAMESPACE" --timeout=120s || error "Timeout en $NAME"
}

# ── Espera a que un Job termine ──────────────────────────────────────────────
waitJob() {
  local NAME=$1
  info "Esperando job/$NAME..."
  kubectl wait job/"$NAME" \
    -n "$NAMESPACE" \
    --for=condition=complete \
    --timeout=300s || {
      warn "Job $NAME no completó a tiempo. Revisando logs..."
      kubectl logs -n "$NAMESPACE" -l app="$NAME" --tail=50
      error "Job $NAME falló"
    }
}

# ════════════════════════════════════════════════════════════════════════════
networkUp() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║     Fabric CA — Deploy en Kubernetes                    ║"
  echo "╚══════════════════════════════════════════════════════════╝"

  step "1/6 — Namespace y Secrets"
  kubectl apply -f "$MANIFESTS_DIR/00-namespace-configmaps.yaml"
  kubectl apply -f "$MANIFESTS_DIR/00-secrets.yaml"

  step "2/6 — RBAC y Network Policies"
  kubectl apply -f "$MANIFESTS_DIR/06-rbac.yaml"

  step "3/6 — PersistentVolumeClaims"
  kubectl apply -f "$MANIFESTS_DIR/01-persistent-volumes.yaml"

  step "4/6 — Desplegando CAs"
  kubectl apply -f "$MANIFESTS_DIR/02-ca-org1.yaml"
  kubectl apply -f "$MANIFESTS_DIR/03-ca-org2.yaml"
  kubectl apply -f "$MANIFESTS_DIR/04-ca-orderer.yaml"

  waitDeployment ca-org1
  waitDeployment ca-org2
  waitDeployment ca-orderer

  step "5/6 — Ejecutando Job de Register & Enroll"
  # Eliminar job anterior si existe
  kubectl delete job fabric-enroll -n "$NAMESPACE" --ignore-not-found=true
  sleep 3
  kubectl apply -f "$MANIFESTS_DIR/05-enroll-job.yaml"
  waitJob fabric-enroll

  step "6/6 — Estado final"
  networkStatus

  echo ""
  info "¡Despliegue completado! 🎉"
  echo ""
  echo "  Los materiales criptográficos están en el PVC: crypto-store"
  echo ""
  echo "  Endpoints internos del cluster:"
  echo "  CA Org1   → https://ca-org1.fabric.svc.cluster.local:7054"
  echo "  CA Org2   → https://ca-org2.fabric.svc.cluster.local:8054"
  echo "  CA Orderer→ https://ca-orderer.fabric.svc.cluster.local:9054"
  echo ""
}

networkDown() {
  step "Eliminando recursos de Kubernetes..."
  kubectl delete -f "$MANIFESTS_DIR/05-enroll-job.yaml"   --ignore-not-found=true
  kubectl delete -f "$MANIFESTS_DIR/04-ca-orderer.yaml"   --ignore-not-found=true
  kubectl delete -f "$MANIFESTS_DIR/03-ca-org2.yaml"      --ignore-not-found=true
  kubectl delete -f "$MANIFESTS_DIR/02-ca-org1.yaml"      --ignore-not-found=true
  kubectl delete -f "$MANIFESTS_DIR/06-rbac.yaml"         --ignore-not-found=true
  kubectl delete -f "$MANIFESTS_DIR/00-secrets.yaml"      --ignore-not-found=true

  read -p "¿Eliminar también los PVCs (perderás los certs)? (s/N): " confirm
  if [[ "$confirm" =~ ^[Ss]$ ]]; then
    kubectl delete -f "$MANIFESTS_DIR/01-persistent-volumes.yaml" --ignore-not-found=true
    warn "PVCs eliminados — los certificados se perdieron."
  fi

  info "Network eliminado ✓"
}

networkStatus() {
  echo ""
  echo "════════ Deployments ════════════════════════════════════"
  kubectl get deployments -n "$NAMESPACE" \
    -l component=ca \
    -o wide 2>/dev/null || true

  echo ""
  echo "════════ Pods ══════════════════════════════════════════"
  kubectl get pods -n "$NAMESPACE" \
    -l component=ca \
    -o wide 2>/dev/null || true

  echo ""
  echo "════════ Services ══════════════════════════════════════"
  kubectl get services -n "$NAMESPACE" 2>/dev/null || true

  echo ""
  echo "════════ PVCs ══════════════════════════════════════════"
  kubectl get pvc -n "$NAMESPACE" 2>/dev/null || true

  echo ""
  echo "════════ Jobs ══════════════════════════════════════════"
  kubectl get jobs -n "$NAMESPACE" 2>/dev/null || true
}

networkLogs() {
  local TARGET=${2:-ca-org1}
  echo ""
  info "Logs de: $TARGET"
  kubectl logs -n "$NAMESPACE" -l app="$TARGET" --tail=100 -f
}

case "$1" in
  up)      networkUp ;;
  down)    networkDown ;;
  status)  networkStatus ;;
  logs)    networkLogs "$@" ;;
  *)
    echo ""
    echo "Uso: $0 [up|down|status|logs <app>]"
    echo ""
    echo "  up          — Despliega CAs y genera certificados"
    echo "  down        — Elimina recursos (pide confirmación para PVCs)"
    echo "  status      — Estado de pods, services y PVCs"
    echo "  logs <app>  — Logs en tiempo real (default: ca-org1)"
    echo ""
    echo "  Ejemplos:"
    echo "    ./deploy.sh up"
    echo "    ./deploy.sh logs ca-org2"
    echo "    ./deploy.sh status"
    echo ""
    ;;
esac
