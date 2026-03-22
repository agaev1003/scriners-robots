#!/bin/bash
# ═══════════════════════════════════════════════════
#  Установка торгового робота MOEX на чистый сервер
#  Использование:
#    curl -sL https://raw.githubusercontent.com/agaev1003/scriners-robots/main/setup.sh | bash
#  Или:
#    wget -qO- https://raw.githubusercontent.com/agaev1003/scriners-robots/main/setup.sh | bash
# ═══════════════════════════════════════════════════

set -e

REPO="https://github.com/agaev1003/scriners-robots.git"
INSTALL_DIR="/opt/moex-robot"
SERVICE_USER="robot"
TOKEN="t.-oDK697FsJTj0UVL2eVF-0AVFXID_Ueagz34DaTSgYK6pqbCcsIvkyeb6Hv_C5orBsr6T_LAb7I5O4ud9pkjAw"
PORT=8080

echo ""
echo "══════════════════════════════════════"
echo "  Установка MOEX Trading Robot"
echo "══════════════════════════════════════"
echo ""

# ─── 1. Обновление системы ───
echo "[1/8] Обновление системы..."
apt-get update -qq
apt-get upgrade -y -qq

# ─── 2. Node.js 20 ───
echo "[2/8] Установка Node.js 20..."
if ! command -v node &>/dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
echo "       Node.js $(node -v)"

# ─── 3. Git ───
echo "[3/8] Установка Git..."
apt-get install -y -qq git

# ─── 4. Пользователь ───
echo "[4/8] Создание пользователя '$SERVICE_USER'..."
if ! id "$SERVICE_USER" &>/dev/null; then
  useradd -m -s /bin/bash "$SERVICE_USER"
fi

# ─── 5. Клонирование репозитория ───
echo "[5/8] Клонирование проекта..."
if [ -d "$INSTALL_DIR" ]; then
  echo "       Папка $INSTALL_DIR уже существует, обновляю..."
  cd "$INSTALL_DIR"
  git pull origin main || true
else
  git clone "$REPO" "$INSTALL_DIR"
fi
chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR"

# ─── 6. Настройка .env ───
echo "[6/8] Настройка .env..."
ENV_FILE="$INSTALL_DIR/robot/.env"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" << ENVEOF
TKF_TOKEN=$TOKEN
TKF_ACCOUNT_ID=
DRY_RUN=true
PORT=$PORT
ENVEOF
  chown "$SERVICE_USER":"$SERVICE_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "       .env создан (DRY_RUN=true)"
else
  echo "       .env уже существует, пропускаю"
fi

# ─── 7. Systemd сервисы ───
echo "[7/8] Создание systemd сервисов..."

# Панель (работает постоянно)
cat > /etc/systemd/system/moex-panel.service << SVCEOF
[Unit]
Description=MOEX Robot Web Panel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR/robot
EnvironmentFile=$INSTALL_DIR/robot/.env
ExecStart=/usr/bin/node -e "import('./panel.js').then(m=>m.startPanel(${PORT},process.env.DRY_RUN!=='false',console.log))"
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
SVCEOF

# Робот (один цикл, запускается cron'ом и вручную)
cat > /etc/systemd/system/moex-robot.service << SVCEOF
[Unit]
Description=MOEX Trading Robot (one cycle)
After=network-online.target

[Service]
Type=oneshot
User=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR/robot
EnvironmentFile=$INSTALL_DIR/robot/.env
ExecStart=/usr/bin/node robot.mjs
StandardOutput=append:/var/log/moex-robot.log
StandardError=append:/var/log/moex-robot.log

[Install]
WantedBy=multi-user.target
SVCEOF

# Разрешить пользователю robot перезапускать сервисы без пароля
cat > /etc/sudoers.d/moex-robot << SUDOEOF
$SERVICE_USER ALL=(ALL) NOPASSWD: /bin/systemctl restart moex-panel, /bin/systemctl restart moex-robot, /bin/systemctl restart moex-panel moex-robot
SUDOEOF
chmod 440 /etc/sudoers.d/moex-robot

systemctl daemon-reload
systemctl enable moex-panel
systemctl start moex-panel

# Лог-файл
touch /var/log/moex-robot.log
chown "$SERVICE_USER":"$SERVICE_USER" /var/log/moex-robot.log

# ─── 8. Cron для торговых часов ───
echo "[8/8] Настройка cron (каждые 30 мин, пн-пт, 07-18 МСК)..."
CRON_LINE="*/30 7-18 * * 1-5 cd $INSTALL_DIR/robot && /usr/bin/node robot.mjs >> /var/log/moex-robot.log 2>&1"
(crontab -u "$SERVICE_USER" -l 2>/dev/null | grep -v "robot.mjs"; echo "$CRON_LINE") | crontab -u "$SERVICE_USER" -

# ─── Firewall ───
if command -v ufw &>/dev/null; then
  ufw allow "$PORT"/tcp >/dev/null 2>&1 || true
fi

# ─── Готово ───
IP=$(hostname -I | awk '{print $1}')
echo ""
echo "══════════════════════════════════════"
echo "  ГОТОВО!"
echo "══════════════════════════════════════"
echo ""
echo "  Панель:   http://${IP}:${PORT}"
echo "  Проект:   $INSTALL_DIR"
echo "  Конфиг:   $INSTALL_DIR/robot/.env"
echo "  Логи:     tail -f /var/log/moex-robot.log"
echo ""
echo "  Тест робота:"
echo "    sudo -u $SERVICE_USER bash -c 'cd $INSTALL_DIR/robot && node robot.mjs'"
echo ""
echo "  Когда готовы к боевому режиму:"
echo "    nano $INSTALL_DIR/robot/.env  →  DRY_RUN=false"
echo "    sudo systemctl restart moex-panel"
echo ""
echo "  Обновить код можно прямо из панели"
echo "  (кнопка «Обновить код»)"
echo ""
