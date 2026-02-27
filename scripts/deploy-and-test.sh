#!/bin/bash
# Deploy changes and run automated tests
# Usage: ./scripts/deploy-and-test.sh [--skip-push]

set -e

SKIP_PUSH=false
if [[ "$1" == "--skip-push" ]]; then
  SKIP_PUSH=true
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Kubernetes RPG - Deploy & Test${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

# Step 1: Push changes (unless skipped)
if [ "$SKIP_PUSH" = false ]; then
  echo -e "${YELLOW}🚀 Pushing changes to Git...${NC}"
  git push
  echo -e "${GREEN}✓ Pushed${NC}\n"
else
  echo -e "${YELLOW}⏭️  Skipping git push${NC}\n"
fi

# Step 2: Wait for Argo CD sync
echo -e "${YELLOW}⏳ Waiting for Argo CD to sync...${NC}"
if kubectl wait --for=condition=Synced application/krombat -n argocd --timeout=300s 2>/dev/null; then
  echo -e "${GREEN}✓ Argo CD synced${NC}\n"
else
  echo -e "${RED}✗ Argo CD sync timeout or failed${NC}"
  echo -e "${YELLOW}Checking Argo CD status:${NC}"
  kubectl get application krombat -n argocd -o jsonpath='{.status.sync.status}' 2>/dev/null || echo "Could not get status"
  exit 1
fi

# Step 3: Wait for frontend deployment
echo -e "${YELLOW}⏳ Waiting for frontend deployment to be ready...${NC}"
if kubectl rollout status deployment/rpg-frontend -n rpg-system --timeout=300s 2>/dev/null; then
  echo -e "${GREEN}✓ Frontend deployed${NC}\n"
else
  echo -e "${RED}✗ Frontend deployment timeout${NC}"
  echo -e "${YELLOW}Recent frontend logs:${NC}"
  kubectl logs -n rpg-system deployment/rpg-frontend --tail=20 2>/dev/null || echo "Could not get logs"
  exit 1
fi

# Step 4: Wait for backend deployment
echo -e "${YELLOW}⏳ Waiting for backend deployment to be ready...${NC}"
if kubectl rollout status deployment/rpg-backend -n rpg-system --timeout=300s 2>/dev/null; then
  echo -e "${GREEN}✓ Backend deployed${NC}\n"
else
  echo -e "${RED}✗ Backend deployment timeout${NC}"
  echo -e "${YELLOW}Recent backend logs:${NC}"
  kubectl logs -n rpg-system deployment/rpg-backend --tail=20 2>/dev/null || echo "Could not get logs"
  exit 1
fi

# Step 5: Port-forward frontend
echo -e "${YELLOW}🔌 Setting up port-forward...${NC}"
kubectl port-forward svc/rpg-frontend -n rpg-system 3000:3000 > /dev/null 2>&1 &
PF_PID=$!

# Cleanup function
cleanup() {
  if [ ! -z "$PF_PID" ]; then
    kill $PF_PID 2>/dev/null || true
  fi
}
trap cleanup EXIT

# Wait for port-forward to be ready
sleep 3

# Step 6: Quick curl test
echo -e "${YELLOW}🌐 Testing UI availability...${NC}"
MAX_RETRIES=5
RETRY=0
while [ $RETRY -lt $MAX_RETRIES ]; do
  if curl -f -s http://localhost:3000 > /dev/null 2>&1; then
    echo -e "${GREEN}✓ UI is responding${NC}\n"
    break
  else
    RETRY=$((RETRY+1))
    if [ $RETRY -eq $MAX_RETRIES ]; then
      echo -e "${RED}✗ UI not responding after $MAX_RETRIES attempts${NC}"
      echo -e "${YELLOW}Frontend logs:${NC}"
      kubectl logs -n rpg-system deployment/rpg-frontend --tail=30
      exit 1
    fi
    echo -e "${YELLOW}  Retry $RETRY/$MAX_RETRIES...${NC}"
    sleep 2
  fi
done

# Step 7: Run Playwright smoke tests
echo -e "${YELLOW}🧪 Running smoke tests...${NC}\n"

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
  echo -e "${YELLOW}📦 Installing dependencies...${NC}"
  npm install
fi

# Check if Playwright browsers are installed
if [ ! -d "$HOME/.cache/ms-playwright" ] && [ ! -d "$HOME/Library/Caches/ms-playwright" ]; then
  echo -e "${YELLOW}📦 Installing Playwright browsers...${NC}"
  npx playwright install chromium
fi

# Run tests
if node tests/e2e/smoke-test.js; then
  echo -e "\n${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${GREEN}  ✅ All tests passed!${NC}"
  echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
  exit 0
else
  echo -e "\n${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${RED}  ❌ Tests failed!${NC}"
  echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
  
  echo -e "${YELLOW}📋 Debugging information:${NC}\n"
  
  echo -e "${YELLOW}Frontend logs (last 30 lines):${NC}"
  kubectl logs -n rpg-system deployment/rpg-frontend --tail=30
  
  echo -e "\n${YELLOW}Backend logs (last 30 lines):${NC}"
  kubectl logs -n rpg-system deployment/rpg-backend --tail=30
  
  if [ -f "test-failure.png" ]; then
    echo -e "\n${YELLOW}📸 Screenshot saved to test-failure.png${NC}"
  fi
  
  exit 1
fi
