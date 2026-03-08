#!/bin/bash
# Test currently deployed application
# Usage: ./scripts/deploy-and-test.sh

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  Kubernetes RPG - Smoke Tests${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

# Step 1: Check if deployments are running
echo -e "${YELLOW}🔍 Checking deployments...${NC}"
if kubectl get deployment rpg-frontend -n rpg-system &>/dev/null; then
  echo -e "${GREEN}✓ Frontend deployment exists${NC}"
else
  echo -e "${RED}✗ Frontend deployment not found${NC}"
  exit 1
fi

if kubectl get deployment rpg-backend -n rpg-system &>/dev/null; then
  echo -e "${GREEN}✓ Backend deployment exists${NC}\n"
else
  echo -e "${RED}✗ Backend deployment not found${NC}"
  exit 1
fi

# Step 2: Port-forward frontend
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

# Step 3: Quick curl test
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

# Step 4: Run Playwright smoke tests
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
if node tests/e2e/smoke-test.js && node tests/e2e/run-journeys.js; then
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
