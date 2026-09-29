FROM maven:3-eclipse-temurin-24-alpine@sha256:1e5a24dab38f3160d404439891ad4fd9b7e14b9e3c5bf65e3a953ba7d6ab4e8e AS builder
WORKDIR /build
COPY pom.xml .
RUN mvn dependency:go-offline -B -q
COPY src ./src
RUN mvn package -DskipTests -B -q

FROM eclipse-temurin:25-jre-alpine@sha256:3c0a9084927a221ccd1d007fcaf614465672c0af37aaa834c5184483afe56d61
WORKDIR /app
COPY --from=builder /build/target/*.jar app.jar
EXPOSE 8888
ENTRYPOINT ["java", "-jar", "app.jar"]
