@echo off
cd /d C:\Users\DeWet\TSMStockBot
echo ========================================
echo TSM Stock Bot - Push to GitHub & Render
echo ========================================
set /p msg="Enter commit message (Press Enter for 'Update stock app'): "
if "%msg%"=="" set msg=Update stock app

echo.
echo Adding files...
git add .

echo.
echo Committing changes...
git commit -m "%msg%"

echo.
echo Pushing to GitHub...
git push origin master

echo.
echo ========================================
echo Done! Check your Render dashboard soon.
echo ========================================
pause